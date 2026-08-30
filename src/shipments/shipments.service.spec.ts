import { InternalServerErrorException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// releaseEscrow() used to swallow ANY failure of the actual money-moving UPDATE into a
// fabricated "released" response - the caller (a human admin, or the automated
// dispute-window auto-release job added alongside these tests) would believe escrow had
// been released when the database was never actually touched.
describe('ShipmentsService.releaseEscrow never fakes success on failure', () => {
  const escrowRow = {
    id: 'escrow-1', shipmentId: 'shp-1', amount: 10_000_000, currency: 'NGN', status: 'FUNDED',
    arrivalConfirmed: false, proofOfDeliveryUploaded: false, customerDeliveryConfirmed: false,
    disputeWindowClear: false, platformApproved: false,
  };

  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      shipment: { update: jest.fn().mockResolvedValue(undefined) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
    const mapsProvider = {} as unknown as MapsProviderService;
    return new ShipmentsService(prisma, notifications, mapsProvider);
  }

  it('throws a real error instead of a fake "released" record when the update fails', async () => {
    const queryRawUnsafe = jest.fn()
      .mockResolvedValueOnce([escrowRow]) // findEscrowOrThrow
      .mockRejectedValueOnce(new Error('connection reset')); // the release UPDATE itself
    const service = buildService(queryRawUnsafe);

    await expect(service.releaseEscrow('shp-1', 'ADMIN')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('still returns a real released record on genuine success', async () => {
    const releasedRow = { ...escrowRow, status: 'RELEASED', arrivalConfirmed: true, proofOfDeliveryUploaded: true, customerDeliveryConfirmed: true, disputeWindowClear: true, platformApproved: true };
    const queryRawUnsafe = jest.fn()
      .mockResolvedValueOnce([escrowRow])
      .mockResolvedValueOnce([releasedRow])
      .mockResolvedValueOnce([]); // notifyAssignedDriverOfEscrowRelease's own lookup
    const service = buildService(queryRawUnsafe);

    const result = await service.releaseEscrow('shp-1', 'ADMIN');

    expect(result.status).toBe('RELEASED');
  });
});

// The "Escrow release window" platform setting used to be pure copy - nothing ever
// checked elapsed time and auto-released anything, so a driver could go unpaid
// indefinitely on an otherwise-fine delivery if the customer never confirmed and never
// disputed. autoReleaseEligibleEscrows() is the real implementation, called on a schedule.
describe('ShipmentsService.autoReleaseEligibleEscrows', () => {
  function buildService(candidates: { shipmentId: string; deliveredAt: Date }[], releaseImpl?: () => Promise<unknown>) {
    const queryRawUnsafe = jest.fn()
      .mockResolvedValueOnce(candidates) // the candidate query inside autoReleaseEligibleEscrows
      .mockResolvedValue([]); // any further calls made by releaseEscrow internals
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ key: 'escrow', value: '3' }) },
      shipment: { update: jest.fn().mockResolvedValue(undefined) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
    const mapsProvider = {} as unknown as MapsProviderService;
    const service = new ShipmentsService(prisma, notifications, mapsProvider);
    if (releaseImpl) service.releaseEscrow = jest.fn(releaseImpl) as never;
    return { service, queryRawUnsafe };
  }

  it('releases every eligible candidate and reports a clean summary when there is nothing to do', async () => {
    const { service } = buildService([]);

    const result = await service.autoReleaseEligibleEscrows();

    expect(result).toMatchObject({ windowDays: 3, candidateCount: 0, releasedCount: 0, results: [] });
  });

  it('calls the real releaseEscrow (as ADMIN, with an auto-release note) for each eligible candidate', async () => {
    const releaseEscrow = jest.fn().mockResolvedValue({ status: 'RELEASED' });
    const { service } = buildService([{ shipmentId: 'shp-1', deliveredAt: new Date('2026-08-01') }]);
    service.releaseEscrow = releaseEscrow as never;

    const result = await service.autoReleaseEligibleEscrows();

    expect(releaseEscrow).toHaveBeenCalledWith('shp-1', 'ADMIN', expect.stringContaining('auto-released'));
    expect(result).toMatchObject({ candidateCount: 1, releasedCount: 1 });
    expect(result.results[0]).toMatchObject({ shipmentId: 'shp-1', released: true });
  });

  it('one candidate failing to release does not stop the rest of the batch from being attempted', async () => {
    const releaseEscrow = jest.fn()
      .mockRejectedValueOnce(new Error('escrow already disputed'))
      .mockResolvedValueOnce({ status: 'RELEASED' });
    const { service } = buildService([
      { shipmentId: 'shp-1', deliveredAt: new Date('2026-08-01') },
      { shipmentId: 'shp-2', deliveredAt: new Date('2026-08-02') },
    ]);
    service.releaseEscrow = releaseEscrow as never;

    const result = await service.autoReleaseEligibleEscrows();

    expect(releaseEscrow).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ candidateCount: 2, releasedCount: 1 });
    expect(result.results).toEqual([
      { shipmentId: 'shp-1', released: false, error: 'escrow already disputed' },
      { shipmentId: 'shp-2', released: true },
    ]);
  });
});

// "Maintenance mode" used to be pure copy on the admin platform settings screen despite
// its own description explicitly promising it would block new shipment creation.
describe('ShipmentsService.create is actually gated by the maintenanceMode platform setting', () => {
  function buildService(maintenanceValue: string | null) {
    const findUnique = jest.fn().mockResolvedValue(maintenanceValue === null ? null : { key: 'maintenanceMode', value: maintenanceValue });
    const shipmentCreate = jest.fn();
    const queryRawUnsafe = jest.fn();
    const prisma = {
      platformSetting: { findUnique },
      $queryRawUnsafe: queryRawUnsafe,
      shipment: { create: shipmentCreate },
    } as unknown as PrismaService;
    const notifications = {} as unknown as NotificationsService;
    const mapsProvider = { routeEstimate: jest.fn() } as unknown as MapsProviderService;
    const service = new ShipmentsService(prisma, notifications, mapsProvider);
    return { service, findUnique, shipmentCreate, queryRawUnsafe };
  }

  it('refuses to create a shipment while in maintenance mode, before even checking the customer account', async () => {
    const { service, shipmentCreate, queryRawUnsafe } = buildService('true');

    await expect(service.create('cust-1', {} as never)).rejects.toThrow('maintenance mode');

    expect(shipmentCreate).not.toHaveBeenCalled();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('is not gated when the setting is off, unset, or unreadable (fails open on a read error)', async () => {
    for (const maintenanceValue of ['false', null]) {
      const { service } = buildService(maintenanceValue);
      await expect(service.create('cust-1', {} as never)).rejects.not.toThrow('maintenance mode');
    }

    const throwingFindUnique = jest.fn().mockRejectedValue(new Error('connection reset'));
    const prisma = {
      platformSetting: { findUnique: throwingFindUnique },
      $queryRawUnsafe: jest.fn(),
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);

    await expect(service.create('cust-1', {} as never)).rejects.not.toThrow('maintenance mode');
  });
});

describe('ShipmentsService driver assignment offer expiry', () => {
  function buildService() {
    const staleOffer = {
      id: 'assignment-1',
      shipmentId: 'shipment-1',
      driverId: 'driver-1',
      status: 'OFFERED',
      offeredAt: new Date(Date.now() - 20 * 60_000),
      shipment: { id: 'shipment-1', customerId: 'customer-1' },
    };
    const prisma = {
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ key: 'driverOfferValidityMinutes', value: '15' }) },
      driverAssignment: {
        findMany: jest.fn()
          .mockResolvedValueOnce([staleOffer])
          .mockResolvedValueOnce([{ driverId: 'driver-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      shipment: {
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue({ cargoWeightKg: 8000 }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'driver-2',
            driverVehicles: [{ id: 'vehicle-2', capacityKg: 10000, isActive: true }],
            driverAssignments: [],
          },
        ]),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
    const service = new ShipmentsService(prisma, notifications, {} as MapsProviderService);
    service.offerAssignment = jest.fn().mockResolvedValue({ id: 'assignment-2', status: 'OFFERED' }) as never;
    return { service, prisma, notifications };
  }

  it('expires stale offers and returns the shipment to dispatch', async () => {
    const { service, prisma, notifications } = buildService();

    const result = await service.expireStaleAssignmentOffers('shipment-1');

    expect(result).toEqual({ expiredCount: 1, validityMinutes: 15 });
    expect(prisma.driverAssignment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'assignment-1', status: 'OFFERED' },
      data: expect.objectContaining({ status: 'EXPIRED' }),
    }));
    expect(prisma.shipment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'shipment-1' },
      data: expect.objectContaining({ status: 'QUOTED' }),
    }));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-1' }));
    expect(service.offerAssignment).toHaveBeenCalledWith(
      'shipment-1',
      { driverId: 'driver-2', vehicleId: 'vehicle-2' },
      'DISPATCHER',
    );
  });

  it('automatically reassigns to the nearest recently located eligible driver', async () => {
    const now = new Date();
    const staleOffer = {
      id: 'assignment-1', shipmentId: 'shipment-1', driverId: 'driver-old', status: 'OFFERED',
      offeredAt: new Date(Date.now() - 20 * 60_000), shipment: { id: 'shipment-1', customerId: 'customer-1' },
    };
    const driver = (id: string) => ({
      id,
      driverVehicles: [{ id: `vehicle-${id}`, capacityKg: 10000, isActive: true }],
      driverAssignments: [],
    });
    const prisma = {
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: '15' }) },
      driverAssignment: {
        findMany: jest.fn().mockResolvedValueOnce([staleOffer]).mockResolvedValueOnce([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      shipment: {
        update: jest.fn().mockResolvedValue(undefined),
        findUnique: jest.fn().mockResolvedValue({
          cargoWeightKg: 8000,
          pickupLatitude: 6.5244,
          pickupLongitude: 3.3792,
        }),
      },
      user: { findMany: jest.fn().mockResolvedValue([driver('driver-far'), driver('driver-near')]) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { userId: 'driver-far', availableForAssignments: true, lastKnownLatitude: 9.0765, lastKnownLongitude: 7.3986, locationUpdatedAt: now },
        { userId: 'driver-near', availableForAssignments: true, lastKnownLatitude: 6.53, lastKnownLongitude: 3.38, locationUpdatedAt: now },
      ]),
    } as unknown as PrismaService;
    const service = new ShipmentsService(
      prisma,
      { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
      {} as MapsProviderService,
    );
    service.offerAssignment = jest.fn().mockResolvedValue({ id: 'assignment-2' }) as never;

    await service.expireStaleAssignmentOffers('shipment-1');

    expect(service.offerAssignment).toHaveBeenCalledWith(
      'shipment-1',
      { driverId: 'driver-near', vehicleId: 'vehicle-driver-near' },
      'DISPATCHER',
    );
  });
});

describe('ShipmentsService.listAssignments access control', () => {
  it('does not expose assignment history to an unrelated authenticated user', async () => {
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          customerId: 'customer-owner',
          assignments: [{ driverId: 'driver-1', vehicle: { ownerId: 'truck-owner-1' } }],
        }),
      },
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);

    await expect(service.listAssignments('shipment-1', 'unrelated-user', 'CUSTOMER')).rejects.toThrow(
      'do not have access',
    );
  });
});

describe('ShipmentsService.offerAssignment conflict protection', () => {
  function buildService(activeShipmentAssignment: unknown, activeDriverAssignment: unknown, availableForAssignments = true) {
    const driverAssignment = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn()
        .mockResolvedValueOnce(activeShipmentAssignment)
        .mockResolvedValueOnce(activeDriverAssignment),
      create: jest.fn(),
    };
    const prisma = {
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: '15' }) },
      shipment: {
        findUnique: jest.fn().mockResolvedValue({ id: 'shipment-1', adminApproved: true, cargoWeightKg: 8000 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1', role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED',
          profile: { fullName: 'Driver One' },
          driverVehicles: [{ id: 'vehicle-1', capacityKg: 10000, isActive: true }],
        }),
      },
      driverAssignment,
      $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('"SafetySettings"') ? [{ availableForAssignments }] : [{ status: 'FUNDED' }]),
      ),
    } as unknown as PrismaService;
    return {
      service: new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService),
      driverAssignment,
    };
  }

  it('refuses to create a second live offer for the same shipment', async () => {
    const { service, driverAssignment } = buildService(
      { id: 'assignment-existing', driverId: 'driver-2', status: 'OFFERED' },
      null,
    );

    await expect(service.offerAssignment('shipment-1', { driverId: 'driver-1' }, 'DISPATCHER')).rejects.toThrow(
      'already has a driver offer',
    );
    expect(driverAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses to offer another shipment to a busy driver', async () => {
    const { service, driverAssignment } = buildService(
      null,
      { id: 'assignment-busy', shipmentId: 'shipment-2', status: 'ACCEPTED' },
    );

    await expect(service.offerAssignment('shipment-1', { driverId: 'driver-1' }, 'DISPATCHER')).rejects.toThrow(
      'already has an active shipment',
    );
    expect(driverAssignment.create).not.toHaveBeenCalled();
  });

  it('refuses to offer a shipment to a driver who is offline', async () => {
    const { service, driverAssignment } = buildService(null, null, false);

    await expect(service.offerAssignment('shipment-1', { driverId: 'driver-1' }, 'DISPATCHER')).rejects.toThrow(
      'driver is offline',
    );
    expect(driverAssignment.create).not.toHaveBeenCalled();
  });
});

describe('ShipmentsService.cancelAssignment', () => {
  it('withdraws a pending offer, records the action, and starts reassignment', async () => {
    const assignment = {
      id: 'assignment-1', shipmentId: 'shipment-1', driverId: 'driver-1', vehicleId: 'vehicle-1',
      status: 'OFFERED', offeredAt: new Date(), acceptedAt: null, rejectedAt: null,
      driver: { id: 'driver-1', email: 'driver@tracko.ng', phone: '+2341', profile: { fullName: 'Driver One' } },
      vehicle: { id: 'vehicle-1', plateNumber: 'TRK-1', type: 'Flatbed', capacityKg: 10000 },
      shipment: { id: 'shipment-1', customerId: 'customer-1', timeline: [] },
    };
    const updated = { ...assignment, status: 'CANCELLED', rejectedAt: new Date() };
    const auditCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      driverAssignment: {
        findUnique: jest.fn().mockResolvedValueOnce(assignment).mockResolvedValueOnce(updated),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      shipment: { findUnique: jest.fn().mockResolvedValue({ cargoWeightKg: 8000 }), update: jest.fn().mockResolvedValue(undefined) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ value: '15' }) },
      auditLog: { create: auditCreate },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
    const service = new ShipmentsService(prisma, notifications, {} as MapsProviderService);

    const result = await service.cancelAssignment('assignment-1', 'dispatcher-1', 'DISPATCHER');

    expect(result).toMatchObject({ id: 'assignment-1', status: 'CANCELLED', nextAssignment: null });
    expect(prisma.driverAssignment.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'assignment-1', status: 'OFFERED' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'dispatcher-1', action: 'DRIVER_ASSIGNMENT_CANCELLED' }),
    }));
  });

  it('does not overwrite a driver response that won the race first', async () => {
    const assignment = {
      id: 'assignment-1', shipmentId: 'shipment-1', driverId: 'driver-1', status: 'OFFERED',
      offeredAt: new Date(), shipment: { id: 'shipment-1', customerId: 'customer-1' },
    };
    const shipmentUpdate = jest.fn();
    const prisma = {
      driverAssignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      shipment: { update: shipmentUpdate },
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);

    await expect(service.cancelAssignment('assignment-1', 'dispatcher-1', 'DISPATCHER')).rejects.toThrow(
      'already handled by another action',
    );
    expect(shipmentUpdate).not.toHaveBeenCalled();
  });
});

// getEscrow() used to fall back to a fabricated "amount 240000, status HELD" record
// whenever no Escrow row existed yet (i.e. every fresh shipment, before the customer had
// paid anything) or the query failed. The escrow payment screen reads status HELD as
// already-funded and disables the "Pay & hold in escrow" button - so a customer who had
// never paid a naira would see "Escrow funded" and be unable to start payment.
describe('ShipmentsService.getEscrow never fakes an already-funded escrow', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    return new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);
  }

  it('throws NotFoundException instead of a fake HELD/240000 record when no escrow exists yet', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawUnsafe);

    await expect(service.getEscrow('shp-fresh')).rejects.toThrow('Escrow record not found');
  });

  it('throws instead of a fake record when the query fails', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(new Error('connection reset'));
    const service = buildService(queryRawUnsafe);

    await expect(service.getEscrow('shp-1')).rejects.toThrow();
  });

  it('returns the real record when one exists', async () => {
    const escrowRow = {
      id: 'escrow-1', shipmentId: 'shp-1', amount: 500000, currency: 'NGN', status: 'PENDING',
      arrivalConfirmed: false, proofOfDeliveryUploaded: false, customerDeliveryConfirmed: false,
      disputeWindowClear: false, platformApproved: false,
    };
    const queryRawUnsafe = jest.fn().mockResolvedValue([escrowRow]);
    const service = buildService(queryRawUnsafe);

    const result = await service.getEscrow('shp-1');

    expect(result.status).toBe('PENDING');
    expect(result.amount).toBe(500000);
  });
});

// confirmEscrowCheck() used to fall back to a fabricated "RELEASE_READY, every check
// true" record whenever the UPDATE failed or matched no row - so the release checklist
// could show every box ticked, and the shipment marked ready for payout, even though
// nothing was actually confirmed in the database.
describe('ShipmentsService.confirmEscrowCheck never fakes a confirmation that did not happen', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    return new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);
  }

  it('throws a real error instead of a fake RELEASE_READY record when the update fails', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(new Error('connection reset'));
    const service = buildService(queryRawUnsafe);

    await expect(service.confirmEscrowCheck('shp-1', 'arrivalConfirmed', 'DRIVER')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('throws NotFoundException instead of fabricating success when there is no Escrow row for this shipment', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawUnsafe);

    await expect(service.confirmEscrowCheck('shp-1', 'arrivalConfirmed', 'DRIVER')).rejects.toThrow('Escrow record not found');
  });

  it('returns the real updated record on genuine success', async () => {
    const escrowRow = {
      id: 'escrow-1', shipmentId: 'shp-1', amount: 500000, currency: 'NGN', status: 'FUNDED',
      arrivalConfirmed: true, proofOfDeliveryUploaded: false, customerDeliveryConfirmed: false,
      disputeWindowClear: false, platformApproved: false,
    };
    const queryRawUnsafe = jest.fn().mockResolvedValue([escrowRow]);
    const service = buildService(queryRawUnsafe);

    const result = await service.confirmEscrowCheck('shp-1', 'arrivalConfirmed', 'DRIVER');

    expect(result.releaseChecks.arrivalConfirmed).toBe(true);
  });

  it('still enforces the role gate before ever touching the database', async () => {
    const queryRawUnsafe = jest.fn();
    const service = buildService(queryRawUnsafe);

    await expect(service.confirmEscrowCheck('shp-1', 'platformApproved', 'CUSTOMER')).rejects.toThrow(
      'cannot complete that escrow release check',
    );
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});
