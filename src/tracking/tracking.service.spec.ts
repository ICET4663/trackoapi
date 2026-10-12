import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { AuthUser } from '../common/types/auth-user';

const adminUser: AuthUser = { sub: 'admin-1', role: 'ADMIN' } as AuthUser;
const driverUser: AuthUser = { sub: 'driver-1', role: 'DRIVER' } as AuthUser;

function buildPrisma(overrides: Record<string, unknown> = {}) {
  return {
    shipment: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
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

  it('currentLocation reports a database failure instead of pretending there is no ping', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.currentLocation('shp-1', adminUser))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('locationHistory returns an empty list, not a fake single-point route, when there is no history', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.locationHistory('shp-1', adminUser);

    expect(result).toEqual([]);
  });

  it('locationHistory reports a database failure instead of an empty route', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.locationHistory('shp-1', adminUser))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('deliveryProofs returns an empty list, not a fake "SUBMITTED" proof, for an undelivered shipment', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.deliveryProofs('shp-1', adminUser);

    expect(result).toEqual([]);
  });

  it('deliveryProofs reports a database failure instead of an empty proof list', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.deliveryProofs('shp-1', adminUser))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('does not report a shipment lookup outage as a missing shipment', async () => {
    const prisma = buildPrisma({ shipment: { findFirst: jest.fn().mockRejectedValue(new Error('connection reset')) } });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.currentLocation('shp-1', adminUser))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('does not report a driver-assignment lookup outage as forbidden access', async () => {
    const prisma = buildPrisma({ driverAssignment: { findFirst: jest.fn().mockRejectedValue(new Error('connection reset')) } });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.currentLocation('shp-1', driverUser))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('TrackingService.shipmentEvidence', () => {
  it('returns pickup photos, pickup notes and delivery proof for an authorized shipment', async () => {
    const now = new Date('2026-09-17T10:00:00.000Z');
    const queryRawUnsafe = jest.fn()
      .mockResolvedValueOnce([{ id: 'media-1', url: 'https://files.example/pickup.jpg', label: 'Pickup cargo condition 1 - TRK-1', createdAt: now }])
      .mockResolvedValueOnce([{ id: 'proof-1', photoUrl: 'https://files.example/delivery.jpg', signatureUrl: null, recipientName: 'Ada', note: 'Sealed', status: 'SUBMITTED', submittedAt: now }])
      .mockResolvedValueOnce([{ note: 'Loaded without damage.', createdAt: now }]);
    const prisma = buildPrisma({ $queryRawUnsafe: queryRawUnsafe });
    const service = new TrackingService(prisma, {} as NotificationsService);

    const result = await service.shipmentEvidence('shp-1', adminUser);

    expect(result.pickup.photos[0].url).toContain('pickup.jpg');
    expect(result.pickup.note).toBe('Loaded without damage.');
    expect(result.delivery.proofs[0].photoUrl).toContain('delivery.jpg');
  });

  it('surfaces evidence query failures instead of reporting an empty evidence set', async () => {
    const prisma = buildPrisma({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.shipmentEvidence('shp-1', adminUser)).rejects.toBeInstanceOf(InternalServerErrorException);
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

  it('does not save a ping after a shipment leaves the active delivery stages', async () => {
    const insert = jest.fn().mockResolvedValue([]);
    const prisma = buildPrisma({ $queryRawUnsafe: insert });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { latitude: 6.5, longitude: 3.3 }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(insert.mock.calls[0][0]).toContain('ARRIVED_DESTINATION');
    expect(insert.mock.calls[0][0]).not.toContain("'DELIVERED'");
    expect(insert.mock.calls[0][0]).not.toContain("'COMPLETED'");
  });
});

describe('TrackingService live tracking alerts', () => {
  const savedPing = {
    id: 'ping-new', shipmentId: 'shp-1', driverId: 'driver-1', latitude: 0.3, longitude: 0,
    heading: null, speedKph: 35, note: null, createdAt: new Date(),
  };

  it('alerts the customer and dispatcher when an active trip exceeds its estimate', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([savedPing])
      .mockResolvedValueOnce([{ exists: false }]);
    const prisma = buildPrisma({
      $queryRawUnsafe: query,
      shipment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-1', customerId: 'cust-1', status: 'IN_TRANSIT',
          durationMinutes: 60, destinationLatitude: 1, destinationLongitude: 1,
          timeline: [{ status: 'IN_TRANSIT', createdAt: new Date(Date.now() - 100 * 60_000) }],
          locationPings: [savedPing],
        }),
      },
    });
    const notifications = { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) } as unknown as NotificationsService;
    const service = new TrackingService(prisma, notifications);

    await service.recordLocation('shp-1', adminUser, { latitude: 0.3, longitude: 0, speedKph: 35 });

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cust-1',
      title: 'Shipment delay detected',
      preferenceKey: 'liveTrackingAlerts',
    }));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      role: 'DISPATCHER',
      preferenceKey: 'liveTrackingAlerts',
    }));
  });

  it('detects sustained movement away from the destination without requiring route geometry', async () => {
    const now = Date.now();
    const locationPings = [
      { ...savedPing, latitude: 0.3, createdAt: new Date(now) },
      { ...savedPing, id: 'ping-2', latitude: 0.2, createdAt: new Date(now - 10 * 60_000) },
      { ...savedPing, id: 'ping-1', latitude: 0.1, createdAt: new Date(now - 20 * 60_000) },
    ];
    const query = jest.fn()
      .mockResolvedValueOnce([savedPing])
      .mockResolvedValueOnce([{ exists: false }]);
    const prisma = buildPrisma({
      $queryRawUnsafe: query,
      shipment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-1', customerId: 'cust-1', status: 'IN_TRANSIT',
          durationMinutes: null, destinationLatitude: 0, destinationLongitude: 0,
          timeline: [{ status: 'IN_TRANSIT', createdAt: new Date(now - 30 * 60_000) }],
          locationPings,
        }),
      },
    });
    const notifications = { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) } as unknown as NotificationsService;
    const service = new TrackingService(prisma, notifications);

    await service.recordLocation('shp-1', adminUser, { latitude: 0.3, longitude: 0, speedKph: 35 });

    expect(prisma.shipment.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ locationPings: { orderBy: { createdAt: 'desc' }, take: 100 } }),
    }));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Possible route deviation',
      preferenceKey: 'liveTrackingAlerts',
    }));
  });

  it('does not repeat an alert inside its deduplication window', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([savedPing])
      .mockResolvedValueOnce([{ exists: true }]);
    const prisma = buildPrisma({
      $queryRawUnsafe: query,
      shipment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-1', customerId: 'cust-1', status: 'IN_TRANSIT',
          durationMinutes: 60, destinationLatitude: 1, destinationLongitude: 1,
          timeline: [{ status: 'IN_TRANSIT', createdAt: new Date(Date.now() - 100 * 60_000) }],
          locationPings: [savedPing],
        }),
      },
    });
    const notifications = { create: jest.fn() } as unknown as NotificationsService;
    const service = new TrackingService(prisma, notifications);

    await service.recordLocation('shp-1', adminUser, { latitude: 0.3, longitude: 0 });

    expect(notifications.create).not.toHaveBeenCalled();
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

  it.each([
    { latitude: 90.01, longitude: 3.3 },
    { latitude: -90.01, longitude: 3.3 },
    { latitude: 6.5, longitude: 180.01 },
    { latitude: 6.5, longitude: -180.01 },
    { latitude: Number.NaN, longitude: 3.3 },
  ])('rejects an out-of-range GPS point before saving it: %j', async (input) => {
    const prisma = buildPrisma();
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, input))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
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

// A driver app that goes offline queues GPS fixes and sends them later. The API must keep
// each fix's real capture time (so a delayed fix is neither shown as fresh nor allowed to
// replace a newer position), tolerate retried requests without duplicating the trail, and
// stay compatible with app versions that send none of this metadata.
describe('TrackingService.recordLocation capture time, accuracy and idempotency', () => {
  const baseRow = {
    id: 'ping-1', shipmentId: 'shp-1', driverId: 'driver-1', latitude: 6.5, longitude: 3.3,
    heading: null, speedKph: null, note: null, createdAt: new Date(), recordedAt: null, accuracyM: null,
  };
  const ping = { latitude: 6.5, longitude: 3.3 };

  it('stores the device capture time, accuracy and client id, and reports the capture time as createdAt', async () => {
    const capturedAt = new Date(Date.now() - 5 * 60_000);
    const received = new Date();
    const insert = jest.fn().mockResolvedValue([{ ...baseRow, createdAt: received, recordedAt: capturedAt, accuracyM: 12 }]);
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: insert }), {} as NotificationsService);

    const result = await service.recordLocation('shp-1', adminUser, {
      ...ping, recordedAt: capturedAt.toISOString(), accuracyM: 12, clientPingId: 'ping-abcdef12',
    });

    expect(insert.mock.calls[0].slice(9)).toEqual([capturedAt, 12, 'ping-abcdef12']);
    expect(result.createdAt).toBe(capturedAt.toISOString());
    expect(result.receivedAt).toBe(received.toISOString());
    expect(result.accuracyM).toBe(12);
  });

  it('still accepts an older app version that sends no capture metadata', async () => {
    const insert = jest.fn().mockResolvedValue([baseRow]);
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: insert }), {} as NotificationsService);

    const result = await service.recordLocation('shp-1', adminUser, ping);

    expect(insert.mock.calls[0].slice(9)).toEqual([null, null, null]);
    expect(result.createdAt).toBe(baseRow.createdAt.toISOString());
  });

  it.each([
    ['an unparseable recordedAt', { recordedAt: 'not-a-date' }],
    ['a recordedAt far in the future', { recordedAt: new Date(Date.now() + 10 * 60_000).toISOString() }],
    ['a recordedAt older than the offline-queue limit', { recordedAt: new Date(Date.now() - 13 * 3600_000).toISOString() }],
    ['a negative accuracy', { accuracyM: -1 }],
    ['an absurd accuracy', { accuracyM: 1_000_000 }],
    ['a malformed clientPingId', { clientPingId: 'has spaces!' }],
    ['a too-short clientPingId', { clientPingId: 'abc' }],
  ])('rejects %s without touching the database', async (_label, extra) => {
    const insert = jest.fn().mockResolvedValue([baseRow]);
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: insert }), {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { ...ping, ...extra })).rejects.toBeInstanceOf(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('tolerates a few seconds of device clock skew ahead of the server', async () => {
    const insert = jest.fn().mockResolvedValue([baseRow]);
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: insert }), {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { ...ping, recordedAt: new Date(Date.now() + 30_000).toISOString() }))
      .resolves.toBeDefined();
  });

  it('returns the original ping when a client retries the same fix instead of storing a duplicate', async () => {
    const stored = { ...baseRow, id: 'ping-original' };
    const query = jest.fn()
      .mockResolvedValueOnce([])        // insert hit the unique (shipmentId, clientPingId) index
      .mockResolvedValueOnce([stored]); // lookup of the original
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: query }), {} as NotificationsService);

    const result = await service.recordLocation('shp-1', adminUser, { ...ping, clientPingId: 'ping-abcdef12' });

    expect(result.id).toBe('ping-original');
    expect(query.mock.calls[0][0]).toContain('on conflict ("shipmentId", "clientPingId")');
  });

  it('still ends location sharing with a 409 for a queued fix sent after the trip finished', async () => {
    const query = jest.fn().mockResolvedValue([]); // nothing inserted, no earlier duplicate either
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: query }), {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, { ...ping, clientPingId: 'ping-abcdef12' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('orders the latest position and the trail by capture time, so a late fix cannot replace a newer one', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new TrackingService(buildPrisma({ $queryRawUnsafe: query }), {} as NotificationsService);

    await service.currentLocation('shp-1', adminUser);
    await service.locationHistory('shp-1', adminUser);

    for (const [sql] of query.mock.calls) {
      expect(sql).toContain('order by coalesce("recordedAt", "createdAt") desc');
    }
  });

  it('runs alert checks for a fresh fix but not for a delayed one drained from an offline queue', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = buildPrisma({
      shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }), findUnique },
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ ...baseRow, recordedAt: new Date(Date.now() - 20 * 60_000) }])
        .mockResolvedValueOnce([{ ...baseRow, recordedAt: new Date(Date.now() - 5_000) }]),
    });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await service.recordLocation('shp-1', adminUser, { ...ping, recordedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    expect(findUnique).not.toHaveBeenCalled();

    await service.recordLocation('shp-1', adminUser, { ...ping, recordedAt: new Date(Date.now() - 5_000).toISOString() });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('creates the additive columns once per process, and retries after a failed attempt', async () => {
    const execute = jest.fn().mockRejectedValueOnce(new Error('ddl lock timeout')).mockResolvedValue(undefined);
    const prisma = buildPrisma({ $executeRawUnsafe: execute, $queryRawUnsafe: jest.fn().mockResolvedValue([baseRow]) });
    const service = new TrackingService(prisma, {} as NotificationsService);

    await expect(service.recordLocation('shp-1', adminUser, ping)).rejects.toBeInstanceOf(InternalServerErrorException);
    await service.recordLocation('shp-1', adminUser, ping);
    const callsAfterRecovery = execute.mock.calls.length;
    await service.recordLocation('shp-1', adminUser, ping);

    expect(execute.mock.calls.length).toBe(callsAfterRecovery);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('add column if not exists "clientPingId"'))).toBe(true);
  });
});

// Location is personal data: a finished shipment's GPS trail must not be kept forever, but a
// trail attached to an unresolved dispute is evidence and must survive the window.
describe('TrackingService location history retention', () => {
  function serviceWith(setting: unknown, query: jest.Mock) {
    const prisma = buildPrisma({
      platformSetting: { findUnique: jest.fn().mockResolvedValue(setting) },
      $queryRawUnsafe: query,
    });
    return new TrackingService(prisma, {} as NotificationsService);
  }

  it.each([
    [null, 30],
    [{ value: '90' }, 90],
    [{ value: '2' }, 7],
    [{ value: '9999' }, 365],
    [{ value: 'soon' }, 30],
  ])('reads the retention window from the platform setting (%j -> %i days), defaulting and clamping', async (setting, days) => {
    const service = serviceWith(setting, jest.fn().mockResolvedValue([{ count: 0 }]));

    await expect(service.locationRetentionDays()).resolves.toBe(days);
  });

  it('only deletes the trail of finished shipments past the window, and never one under an open dispute', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 3 }]);
    const service = serviceWith({ value: '45' }, query);

    const result = await service.purgeExpiredLocationHistory();

    const [sql, days] = query.mock.calls[0];
    expect(sql).toContain("'COMPLETED'::\"ShipmentStatus\", 'CANCELLED'::\"ShipmentStatus\"");
    expect(sql).not.toContain("'DELIVERED'");
    expect(sql).toContain("'OPEN'::\"DisputeStatus\", 'IN_REVIEW'::\"DisputeStatus\"");
    expect(sql).toContain('delete from "ShipmentLocationPing"');
    expect(days).toBe('45');
    expect(result).toMatchObject({ retentionDays: 45, deleted: 3 });
  });

  it('works in bounded batches and stops as soon as a batch comes back short', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ count: 100 }])
      .mockResolvedValueOnce([{ count: 100 }])
      .mockResolvedValueOnce([{ count: 40 }]);
    const service = serviceWith(null, query);

    const result = await service.purgeExpiredLocationHistory({ batchSize: 100, maxBatches: 5 });

    expect(query).toHaveBeenCalledTimes(3);
    expect(result.deleted).toBe(240);
  });

  it('never runs more batches than allowed in one scheduled run', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 100 }]);
    const service = serviceWith(null, query);

    await service.purgeExpiredLocationHistory({ batchSize: 100, maxBatches: 2 });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reports a database failure instead of pretending the purge ran', async () => {
    const service = serviceWith(null, jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.purgeExpiredLocationHistory()).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

