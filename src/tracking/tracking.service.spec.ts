import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { AuthUser } from '../common/types/auth-user';

const adminUser: AuthUser = { sub: 'admin-1', role: 'ADMIN' } as AuthUser;

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    shipment: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
      update: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
    },
    driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PrismaService;
}

// currentLocation()/locationHistory()/deliveryProofs() used to fabricate a fixed Lagos
// GPS ping (or a "SUBMITTED, Preview recipient" proof) whenever no real row existed yet -
// the normal state for any shipment before a driver had sent a ping or delivered. That
// fake data was shown directly on the customer tracking map and delivery-confirmation
// screen. They must return an honest null/empty instead.
describe('TrackingService read paths never fabricate a location or a delivery proof', () => {
  it('currentLocation returns null, not a fake Lagos ping, when there is no ping yet', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.currentLocation('shp-1', adminUser);

    expect(result).toBeNull();
  });

  it('currentLocation returns null, not fake data, when the query fails', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.currentLocation('shp-1', adminUser);

    expect(result).toBeNull();
  });

  it('locationHistory returns an empty list, not a fake single-point route, when there is no history', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.locationHistory('shp-1', adminUser);

    expect(result).toEqual([]);
  });

  it('deliveryProofs returns an empty list, not a fake "SUBMITTED" proof, for an undelivered shipment', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.deliveryProofs('shp-1', adminUser);

    expect(result).toEqual([]);
  });
});

// recordLocation() used to echo the driver's submitted coordinates straight back as a
// fake "saved" ping whenever the INSERT failed - so a driver's GPS trail could silently
// stop being recorded with no error surfaced anywhere.
describe('TrackingService.recordLocation never fakes a saved ping on failure', () => {
  it('throws instead of echoing back a fake saved ping when the insert fails', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { latitude: 6.5, longitude: 3.3 }))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('returns the real saved ping on success', async () => {
    const savedRow = {
      id: 'ping-1', shipmentId: 'shp-1', driverId: 'admin-1', latitude: 6.5, longitude: 3.3,
      heading: null, speedKph: null, note: null, createdAt: new Date(),
    };
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([savedRow]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.recordLocation('shp-1', adminUser, { latitude: 6.5, longitude: 3.3 });

    expect(result.id).toBe('ping-1');
  });
});

// recordLocation() used to default a missing latitude/longitude to a fixed Lagos
// coordinate instead of rejecting the request - a malformed GPS payload would get
// silently recorded into the permanent trail as if the driver were really there.
describe('TrackingService.recordLocation rejects a ping with no real coordinates', () => {
  it('throws BadRequestException when latitude is missing', async () => {
    const prisma = buildPrisma();
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { longitude: 3.3 } as never))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when longitude is missing', async () => {
    const prisma = buildPrisma();
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { latitude: 6.5 } as never))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a real equatorial/prime-meridian zero coordinate rather than treating it as missing', async () => {
    const savedRow = {
      id: 'ping-1', shipmentId: 'shp-1', driverId: 'admin-1', latitude: 0, longitude: 0,
      heading: null, speedKph: null, note: null, createdAt: new Date(),
    };
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([savedRow]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.recordLocation('shp-1', adminUser, { latitude: 0, longitude: 0 });

    expect(result.latitude).toBe(0);
  });
});

// submitDeliveryProof() used to wrap the real proof insert, the DELIVERED transition, the
// Escrow proofOfDeliveryUploaded flip, AND the notifications in one try/catch - so any
// failure among them fell back to a fabricated "SUBMITTED" proof. A driver could believe
// delivery was recorded while nothing was saved and the escrow release checklist never
// advanced.
describe('TrackingService.submitDeliveryProof never fakes a recorded delivery', () => {
  function buildService(overrides: Record<string, unknown> = {}) {
    const prisma = buildPrisma(overrides);
    const notifications = { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) } as unknown as NotificationsService;
    return { service: new TrackingService(prisma, notifications), notifications, prisma };
  }

  it('throws instead of a fake proof when the insert itself fails', async () => {
    const { service } = buildService({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.submitDeliveryProof('shp-1', adminUser, {})).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('throws instead of a fake proof when the shipment DELIVERED transition fails', async () => {
    const proofRow = {
      id: 'proof-1', shipmentId: 'shp-1', driverId: 'admin-1', photoUrl: null, signatureUrl: null,
      recipientName: null, note: null, status: 'SUBMITTED', submittedAt: new Date(),
    };
    const { service } = buildService({
      $queryRawUnsafe: jest.fn().mockResolvedValue([proofRow]),
      shipment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
        update: jest.fn().mockRejectedValue(new Error('connection reset')),
      },
    });

    await expect(service.submitDeliveryProof('shp-1', adminUser, {})).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('still returns the real proof even if the best-effort notifications fail', async () => {
    const proofRow = {
      id: 'proof-1', shipmentId: 'shp-1', driverId: 'admin-1', photoUrl: null, signatureUrl: null,
      recipientName: 'Jane', note: null, status: 'SUBMITTED', submittedAt: new Date(),
    };
    const { service, notifications } = buildService({ $queryRawUnsafe: jest.fn().mockResolvedValue([proofRow]) });
    (notifications.create as jest.Mock).mockRejectedValue(new Error('notification service down'));

    const result = await service.submitDeliveryProof('shp-1', adminUser, {});

    expect(result.id).toBe('proof-1');
    expect(result.recipientName).toBe('Jane');
  });

  it('flips escrow proofOfDeliveryUploaded on genuine success', async () => {
    const proofRow = {
      id: 'proof-1', shipmentId: 'shp-1', driverId: 'admin-1', photoUrl: null, signatureUrl: null,
      recipientName: null, note: null, status: 'SUBMITTED', submittedAt: new Date(),
    };
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService({
      $queryRawUnsafe: jest.fn().mockResolvedValue([proofRow]),
      $executeRawUnsafe: executeRawUnsafe,
    });

    await service.submitDeliveryProof('shp-1', adminUser, {});

    expect(executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('"proofOfDeliveryUploaded" = true'), 'shp-1');
  });
});
