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
