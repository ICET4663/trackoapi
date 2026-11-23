import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { resetJobRequestTableForTests } from './job-board-store';
import { JobBoardService } from './job-board.service';
import { ShipmentsService } from './shipments.service';

const readyTruck = {
  id: 'truck-1',
  capacityKg: 5000,
  capacityM3: 30,
  documents: [],
};

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ship-1',
    reference: 'TRK-1',
    customerId: 'customer-1',
    status: 'ESCROW_FUNDED',
    adminApproved: true,
    adminApprovedAt: new Date('2026-11-23T10:00:00Z'),
    createdAt: new Date('2026-11-23T09:00:00Z'),
    pickupLabel: 'Ikeja, Lagos',
    destinationLabel: 'Wuse, Abuja',
    pickupLatitude: 6.6,
    pickupLongitude: 3.35,
    destinationLatitude: 9.07,
    destinationLongitude: 7.48,
    cargoDescription: 'Cement',
    cargoWeightKg: 1000,
    cargoVolumeM3: null,
    quotedPriceKobo: 25_000_000,
    distanceKm: 760,
    durationMinutes: 600,
    customer: { email: 'customer@example.com' },
    ...overrides,
  };
}

/** Routes raw SQL to canned answers by a fragment of its text. */
function rawRouter(routes: Array<[string, unknown]>) {
  return jest.fn(async (sql: string) => {
    for (const [fragment, answer] of routes) {
      if (sql.includes(fragment)) return typeof answer === 'function' ? (answer as () => unknown)() : answer;
    }
    return [];
  });
}

function build(prismaParts: Record<string, unknown>, shipmentsParts: Partial<ShipmentsService> = {}) {
  const notify = jest.fn().mockResolvedValue(null);
  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    ...prismaParts,
  } as unknown as PrismaService;
  const shipments = {
    isVehicleAssignmentReady: () => true,
    checkAssignmentEligibility: jest.fn().mockResolvedValue({ shipment: shipmentRow(), vehicle: readyTruck }),
    ...shipmentsParts,
  } as unknown as ShipmentsService;
  const service = new JobBoardService(prisma, shipments, { create: notify } as unknown as NotificationsService);
  return { service, notify, prisma, shipments };
}

describe('JobBoardService', () => {
  beforeEach(() => resetJobRequestTableForTests());

  describe('listForDriver', () => {
    const verifiedDriver = {
      id: 'driver-1',
      role: 'DRIVER',
      isActive: true,
      verificationStatus: 'VERIFIED',
      email: 'driver@example.com',
      driverVehicles: [readyTruck],
    };

    it('shows no loads while the driver has an undelivered trip', async () => {
      const { service } = build({
        user: { findUnique: jest.fn().mockResolvedValue(verifiedDriver) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue({ shipment: { reference: 'TRK-ACTIVE' } }) },
      });

      await expect(service.listForDriver('driver-1')).resolves.toEqual({ state: 'ON_TRIP', activeTrip: 'TRK-ACTIVE', loads: [] });
    });

    it('lists loads a truck can carry, nearest first, without ones the customer declined', async () => {
      const findMany = jest.fn().mockResolvedValue([
        shipmentRow({ id: 'far', reference: 'TRK-FAR', pickupLatitude: 9.0, pickupLongitude: 7.4 }),
        shipmentRow({ id: 'near', reference: 'TRK-NEAR', pickupLatitude: 6.61, pickupLongitude: 3.36 }),
        shipmentRow({ id: 'heavy', reference: 'TRK-HEAVY', cargoWeightKg: 20_000 }),
        shipmentRow({ id: 'declined', reference: 'TRK-NO' }),
        shipmentRow({ id: 'sandbox', reference: 'TRK-TEST', customer: { email: 'apple.review.customer@trako.com.ng' } }),
      ]);
      const { service } = build({
        user: { findUnique: jest.fn().mockResolvedValue(verifiedDriver) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        shipment: { findMany },
        $queryRawUnsafe: rawRouter([
          ['from "SafetySettings"', [{
            availableForAssignments: true,
            lastKnownLatitude: 6.6,
            lastKnownLongitude: 3.35,
            locationUpdatedAt: new Date(),
          }]],
          ['from "JobRequest"', [
            { shipmentId: 'near', status: 'PENDING' },
            { shipmentId: 'declined', status: 'DECLINED' },
          ]],
        ]),
      });

      const result = await service.listForDriver('driver-1');

      expect(result.state).toBe('OPEN');
      expect(result.loads.map((load) => load.shipmentId)).toEqual(['TRK-NEAR', 'TRK-FAR']);
      expect(result.loads[0]).toMatchObject({ requested: true, quotedPriceKobo: 25_000_000 });
      expect(result.loads[0].pickupKm).toBeLessThan(5);
      expect(result.loads[1].requested).toBe(false);
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ assignments: { none: { status: { in: ['OFFERED', 'ACCEPTED'] } } } }),
      }));
    });

    it('shows unpaid and awaiting-approval loads too, tagged, measured from the phone position', async () => {
      const findMany = jest.fn().mockResolvedValue([
        shipmentRow({ id: 'paid', reference: 'TRK-PAID', pickupLatitude: 9.0, pickupLongitude: 7.4 }),
        shipmentRow({ id: 'unpaid', reference: 'TRK-UNPAID', status: 'PENDING_PAYMENT', adminApproved: false, adminApprovedAt: null, pickupLatitude: 9.06, pickupLongitude: 7.49 }),
        shipmentRow({ id: 'checking', reference: 'TRK-CHECK', adminApproved: false, adminApprovedAt: null, pickupLatitude: 6.6, pickupLongitude: 3.35 }),
      ]);
      const { service } = build({
        user: { findUnique: jest.fn().mockResolvedValue(verifiedDriver) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        shipment: { findMany },
        $queryRawUnsafe: rawRouter([['from "SafetySettings"', [{ availableForAssignments: true }]]]),
      });

      // The phone is in Abuja; the driver has no stored trip position.
      const result = await service.listForDriver('driver-1', { latitude: 9.07, longitude: 7.48 });

      expect(result.position).toEqual({ latitude: 9.07, longitude: 7.48 });
      expect(result.loads.map((load) => [load.shipmentId, load.boardStatus, load.paid])).toEqual([
        ['TRK-UNPAID', 'AWAITING_PAYMENT', false],
        ['TRK-PAID', 'READY', true],
        ['TRK-CHECK', 'AWAITING_APPROVAL', true],
      ]);
      expect(result.loads[0].pickupKm).toBeLessThan(3);
      const where = findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { status: 'ESCROW_FUNDED', escrow: { is: { status: { in: ['FUNDED', 'HELD', 'RELEASE_READY'] } } } },
        { status: { in: ['DRAFT', 'QUOTED', 'PENDING_PAYMENT'] }, createdAt: { gte: expect.any(Date) } },
      ]);
      expect(where.adminApproved).toBeUndefined();
    });

    it('ignores a nonsense phone position', async () => {
      const { service } = build({
        user: { findUnique: jest.fn().mockResolvedValue(verifiedDriver) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        shipment: { findMany: jest.fn().mockResolvedValue([shipmentRow()]) },
      });

      const result = await service.listForDriver('driver-1', { latitude: Number.NaN, longitude: 400 });
      expect(result.position).toBeNull();
      expect(result.loads[0].pickupKm).toBeNull();
    });
  });

  describe('request', () => {
    it('refuses a driver whose current trip is not delivered', async () => {
      const { service } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue({ shipment: { reference: 'TRK-ACTIVE' } }) },
      });

      await expect(service.request('driver-1', 'TRK-1')).rejects.toThrow('Mark TRK-ACTIVE delivered');
    });

    it('records the request after the dispatch eligibility rules and tells the customer', async () => {
      const { service, notify, shipments } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        user: {
          findUnique: jest.fn()
            .mockResolvedValueOnce({ id: 'driver-1', email: 'driver@example.com', profile: { fullName: 'Musa Ibrahim Bello' } })
            .mockResolvedValueOnce({ email: 'customer@example.com' }),
        },
        $queryRawUnsafe: rawRouter([['insert into "JobRequest"', [{ id: 'req-1' }]]]),
      });

      await expect(service.request('driver-1', 'TRK-1')).resolves.toEqual({ requestId: 'req-1', status: 'PENDING' });
      expect(shipments.checkAssignmentEligibility).toHaveBeenCalledWith('ship-1', 'driver-1', undefined, { beforePayment: false });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'customer-1',
        body: expect.stringContaining('Musa B. asked to carry TRK-1'),
      }));
    });

    it('lets a driver ask for an unpaid load, checking the driver rules but not payment', async () => {
      const { service, notify, shipments } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow({ status: 'PENDING_PAYMENT', adminApproved: false })) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        user: {
          findUnique: jest.fn()
            .mockResolvedValueOnce({ id: 'driver-1', email: 'driver@example.com', profile: { fullName: 'Musa Bello' } })
            .mockResolvedValueOnce({ email: 'customer@example.com' }),
        },
        $queryRawUnsafe: rawRouter([['insert into "JobRequest"', [{ id: 'req-2' }]]]),
      });

      await expect(service.request('driver-1', 'TRK-1')).resolves.toEqual({ requestId: 'req-2', status: 'PENDING' });
      expect(shipments.checkAssignmentEligibility).toHaveBeenCalledWith('ship-1', 'driver-1', undefined, { beforePayment: true });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'customer-1',
        body: expect.stringContaining('Pay for the shipment, then choose your driver'),
      }));
    });

    it('refuses a load that was cancelled or already has a driver', async () => {
      const { service, shipments } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow({ status: 'CANCELLED' })) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'driver-1', email: 'driver@example.com' }) },
      });

      await expect(service.request('driver-1', 'TRK-1')).rejects.toThrow('no longer on the job board');
      expect(shipments.checkAssignmentEligibility).not.toHaveBeenCalled();
    });

    it('does not let a driver ask again after the customer declined', async () => {
      const { service } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
        user: { findUnique: jest.fn().mockResolvedValue({ id: 'driver-1', email: 'driver@example.com' }) },
        $queryRawUnsafe: rawRouter([
          ['insert into "JobRequest"', []],
          ['from "JobRequest"', [{ id: 'req-1', shipmentId: 'ship-1', status: 'DECLINED' }]],
        ]),
      });

      await expect(service.request('driver-1', 'TRK-1')).rejects.toThrow('chose not to take your request');
    });
  });

  describe('approve', () => {
    const pendingRequest = { id: 'req-1', shipmentId: 'ship-1', driverId: 'driver-1', vehicleId: 'truck-1', status: 'PENDING' };

    it('lets only the customer who booked the load (or operations) choose', async () => {
      const { service } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        $queryRawUnsafe: rawRouter([['from "JobRequest" where "id"', [pendingRequest]]]),
      });

      await expect(service.approve('req-1', 'someone-else', 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.approve('req-1', 'driver-1', 'DRIVER')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('locks the load to the chosen driver and closes every other request', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'assignment-1' });
      const update = jest.fn().mockResolvedValue(undefined);
      const { service, notify } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()), update },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue(null), create },
        $queryRawUnsafe: rawRouter([
          ['from "JobRequest" where "id"', [pendingRequest]],
          ['set "status" = \'APPROVED\'', [{ id: 'req-1' }]],
          ['set "status" = \'CLOSED\'', [{ driverId: 'driver-2', shipmentId: 'ship-1' }]],
        ]),
      });

      await expect(service.approve('req-1', 'customer-1', 'CUSTOMER'))
        .resolves.toEqual({ status: 'APPROVED', assignmentId: 'assignment-1', shipmentId: 'ship-1' });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ shipmentId: 'ship-1', driverId: 'driver-1', vehicleId: 'truck-1', status: 'ACCEPTED' }),
      }));
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'DRIVER_EN_ROUTE' }),
      }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'You got the load' }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-2', title: 'Load taken' }));
      expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'customer-1' }));
    });

    it('reopens the request when another driver was confirmed at the same moment', async () => {
      const execute = jest.fn().mockResolvedValue(1);
      const { service } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        driverAssignment: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' })),
        },
        $executeRawUnsafe: execute,
        $queryRawUnsafe: rawRouter([
          ['from "JobRequest" where "id"', [pendingRequest]],
          ['set "status" = \'APPROVED\'', [{ id: 'req-1' }]],
        ]),
      });

      await expect(service.approve('req-1', 'customer-1', 'CUSTOMER')).rejects.toBeInstanceOf(ConflictException);
      expect(execute).toHaveBeenCalledWith(expect.stringContaining('"status" = \'PENDING\''), 'req-1');
    });

    it('makes the customer pay (and an admin approve) before any driver gets the load', async () => {
      for (const [overrides, message] of [
        [{ status: 'PENDING_PAYMENT', adminApproved: false }, 'Pay for this shipment first'],
        [{ status: 'DRAFT', adminApproved: false }, 'Pay for this shipment first'],
        [{ status: 'ESCROW_FUNDED', adminApproved: false }, 'as soon as it is approved'],
      ] as const) {
        const create = jest.fn();
        const { service, shipments } = build({
          shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow(overrides)) },
          driverAssignment: { findFirst: jest.fn().mockResolvedValue(null), create },
          $queryRawUnsafe: rawRouter([['from "JobRequest" where "id"', [pendingRequest]]]),
        });

        await expect(service.approve('req-1', 'customer-1', 'CUSTOMER')).rejects.toThrow(message);
        await expect(service.approve('req-1', 'dispatch-1', 'DISPATCHER')).rejects.toThrow(message);
        expect(create).not.toHaveBeenCalled();
        expect(shipments.checkAssignmentEligibility).not.toHaveBeenCalled();
      }
    });

    it('refuses a driver who has started another trip since asking', async () => {
      const { service } = build({
        shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
        driverAssignment: { findFirst: jest.fn().mockResolvedValue({ shipment: { reference: 'TRK-OTHER' } }) },
        $queryRawUnsafe: rawRouter([['from "JobRequest" where "id"', [pendingRequest]]]),
      });

      await expect(service.approve('req-1', 'customer-1', 'CUSTOMER')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('declines a request and tells the driver', async () => {
    const { service, notify } = build({
      shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow()) },
      $queryRawUnsafe: rawRouter([
        ['from "JobRequest" where "id"', [{ id: 'req-1', shipmentId: 'ship-1', driverId: 'driver-1', status: 'PENDING' }]],
        ['set "status" = \'DECLINED\'', [{ id: 'req-1' }]],
      ]),
    });

    await expect(service.decline('req-1', 'customer-1', 'CUSTOMER')).resolves.toEqual({ status: 'DECLINED' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'Request not taken' }));
  });
});

describe('JobBoardService.announce', () => {
  it('tells only online drivers with no undelivered trip and a truck the load fits', async () => {
    const truck = { capacityKg: 5000, capacityM3: 30, documents: [] };
    const findMany = jest.fn().mockResolvedValue([
      { id: 'free', email: 'a@example.com', driverVehicles: [truck] },
      { id: 'offline', email: 'b@example.com', driverVehicles: [truck] },
      { id: 'small', email: 'c@example.com', driverVehicles: [{ ...truck, capacityKg: 500 }] },
      { id: 'sandbox', email: 'tester01.driver@trako.com.ng', driverVehicles: [truck] },
    ]);
    const { service, notify } = build({
      shipment: { findUnique: jest.fn().mockResolvedValue(shipmentRow()) },
      user: { findMany },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ userId: 'offline' }]),
    });

    await expect(service.announce('ship-1')).resolves.toEqual({ notified: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: 'free', actionUrl: '/driver/jobs' }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        driverAssignments: { none: { status: 'ACCEPTED', shipment: { status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED'] } } } },
      }),
    }));
  });

  it('is hooked to admin approval', () => {
    const { shipments } = build({});
    expect(typeof (shipments as unknown as { onLoadPosted?: unknown }).onLoadPosted).toBe('function');
  });
});
