import { BadRequestException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { DataService, type DataCollection } from './data.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ShipmentsService } from '../shipments/shipments.service';

// platform-users, operation-drivers, operation-shipments, dispatcher-shipments,
// dispatcher-disputes, and chat-threads previously had no role check at any layer -
// any authenticated customer or driver account could pull every user's name/email/
// phone/location and every shipment on the platform. These tests pin the fix: the gate
// must reject before a query ever runs, not just filter the response afterward.
describe('DataService authorization gates', () => {
  let prisma: {
    user: { findMany: jest.Mock };
    shipment: { findMany: jest.Mock };
    driverAssignment: { findMany: jest.Mock };
    conversation: { findMany: jest.Mock };
  };
  let service: DataService;

  const OPS_ONLY: DataCollection[] = [
    'platform-users',
    'operation-drivers',
    'operation-shipments',
    'dispatcher-shipments',
    'dispatcher-disputes',
    'chat-threads',
  ];

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      shipment: { findMany: jest.fn().mockResolvedValue([]) },
      driverAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new DataService(prisma as unknown as PrismaService);
  });

  describe.each(OPS_ONLY)('%s', (collection) => {
    it('rejects a CUSTOMER before running any query', async () => {
      await expect(service.list(collection, 'cust-1', 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.shipment.findMany).not.toHaveBeenCalled();
      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    });

    it('rejects a DRIVER before running any query', async () => {
      await expect(service.list(collection, 'driver-1', 'DRIVER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('rejects a TRUCK_OWNER too - this data is ops-only, not owner-visible', async () => {
      await expect(service.list(collection, 'owner-1', 'TRUCK_OWNER')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('allows ADMIN through the platform-users gate', async () => {
    await expect(service.list('platform-users', 'admin-1', 'ADMIN')).resolves.toBeDefined();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('allows DISPATCHER through the platform-users gate', async () => {
    await expect(service.list('platform-users', 'dispatch-1', 'DISPATCHER')).resolves.toBeDefined();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  describe('seeking-drivers (owner-or-ops, not ops-only)', () => {
    it('rejects a bare CUSTOMER', async () => {
      await expect(service.list('seeking-drivers', 'cust-1', 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('rejects a bare DRIVER', async () => {
      await expect(service.list('seeking-drivers', 'driver-1', 'DRIVER')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a TRUCK_OWNER - this is the legitimate use case', async () => {
      await expect(service.list('seeking-drivers', 'owner-1', 'TRUCK_OWNER')).resolves.toBeDefined();
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    });

    it('allows ADMIN/DISPATCHER too', async () => {
      await expect(service.list('seeking-drivers', 'admin-1', 'ADMIN')).resolves.toBeDefined();
    });

    it('returns the complete driver-pool contract expected by the owner screen', async () => {
      prisma.user.findMany.mockResolvedValueOnce([{
        id: 'driver-1',
        email: 'driver@tracko.ng',
        phone: '+2348000000000',
        verificationStatus: 'VERIFIED',
        updatedAt: new Date(),
        profile: { fullName: 'Trako Driver', city: 'Ikeja', state: 'Lagos' },
        driverVehicles: [{ type: 'Box truck', plateNumber: 'TRK-DRV-01', isActive: true }],
        driverAssignments: [],
        driverReviews: [],
      }]);

      const result = await service.list('seeking-drivers', 'owner-1', 'TRUCK_OWNER');

      expect(result[0]).toMatchObject({
        name: 'Trako Driver',
        state: 'Lagos',
        neededTruck: 'Box truck',
        completedTrips: 0,
        verified: true,
        preferredRoutes: ['Lagos'],
      });
    });
  });

  it('does not gate a self-scoped collection like customer-shipments for a CUSTOMER', async () => {
    // Sanity check that the ops-only gate is additive, not a blanket lockdown - every
    // role must still reach its own legitimately-scoped data.
    await expect(service.list('customer-shipments', 'cust-1', 'CUSTOMER')).resolves.toBeDefined();
    expect(prisma.shipment.findMany).toHaveBeenCalledTimes(1);
  });
});

// list()/create() used to swallow ANY failure (a DB outage, a bad query, a unique
// constraint violation) into a single fabricated "preview" row that was structurally
// identical to real data - every portal screen behind /v1/data/:collection (shipments,
// trucks, wallet, dispatcher queues, platform users...) would silently render fake
// content instead of surfacing the outage, and owner-trucks' create() would tell an
// owner their truck was saved when the Vehicle row was never written.
describe('DataService never fakes success on a real failure', () => {
  it('list() throws instead of returning a fabricated preview row when the read fails', async () => {
    const prisma = {
      shipment: { findMany: jest.fn().mockRejectedValue(new Error('connection reset')) },
    } as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(service.list('customer-shipments', 'cust-1', 'CUSTOMER')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('list() still lets a real ForbiddenException through untouched, not wrapped as a 500', async () => {
    const prisma = {} as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(service.list('platform-users', 'cust-1', 'CUSTOMER')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create() throws instead of a fake "saved" echo when the Vehicle write fails', async () => {
    const prisma = {
      vehicle: { create: jest.fn().mockRejectedValue(new Error('duplicate plate number')) },
    } as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(
      service.create('owner-trucks', { reg: 'LAG-204-TK', type: 'Flatbed', capacity: '30 tons', volumeCapacity: '55' }, 'owner-1'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('create() still rejects a missing plate number as a real BadRequestException', async () => {
    const prisma = {} as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(service.create('owner-trucks', {}, 'owner-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a weight capacity with no plausible unit instead of silently unmatchable truck', async () => {
    const prisma = { vehicle: { create: jest.fn() } } as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(
      service.create('owner-trucks', { reg: 'LAG-204-TK', capacity: '18000', volumeCapacity: '55' }, 'owner-1'),
    ).rejects.toThrow('valid weight capacity');
    expect(prisma.vehicle.create).not.toHaveBeenCalled();
  });

  it('accepts an explicit kg capacity without misreading it as tons', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'vehicle-1', plateNumber: 'LAG-204-TK', type: 'Flatbed' });
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const prisma = { vehicle: { create }, $executeRawUnsafe: executeRawUnsafe } as unknown as PrismaService;
    const service = new DataService(prisma);

    await service.create('owner-trucks', { reg: 'LAG-204-TK', capacity: '18000 kg', volumeCapacity: '55' }, 'owner-1');

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ capacityKg: 18000 }) }));
  });

  it('prevents a non-owner account from registering a truck', async () => {
    const prisma = { vehicle: { create: jest.fn() } } as unknown as PrismaService;
    const service = new DataService(prisma);

    await expect(
      service.create('owner-trucks', { reg: 'TRK-001' }, 'customer-1', 'CUSTOMER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DataService driver workflow collections', () => {
  it('marks a new offer as queued while the driver has another accepted trip', async () => {
    const now = new Date('2026-09-23T10:00:00.000Z');
    const prisma = {
      driverAssignment: {
        findFirst: jest.fn().mockResolvedValue({
          shipmentId: 'active-shipment',
          shipment: { reference: 'TRK-ACTIVE-1' },
        }),
        findMany: jest.fn().mockResolvedValue([{
          id: 'offer-1', shipmentId: 'next-shipment', status: 'OFFERED', offeredAt: now,
          proposedPriceKobo: null, proposedNote: null, proposedAt: null,
          shipment: {
            id: 'next-shipment', reference: 'TRK-NEXT-1', pickupLabel: 'Lagos', destinationLabel: 'Abuja',
            cargoDescription: 'Rice', quotedPriceKobo: 100_000, distanceKm: 500, durationMinutes: 600,
            status: 'DRIVER_ASSIGNED',
          },
          vehicle: { plateNumber: 'TRK-DRV-01' },
        }]),
      },
    } as unknown as PrismaService;
    const shipments = {
      expireStaleAssignmentOffers: jest.fn().mockResolvedValue({ expiredCount: 0, validityMinutes: 15 }),
    } as unknown as ShipmentsService;
    const service = new DataService(prisma, shipments);

    const result = await service.list('driver-jobs', 'driver-1', 'DRIVER') as Array<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      id: 'offer-1',
      queued: true,
      queuedBehindShipment: 'TRK-ACTIVE-1',
    });
    expect(result[0].expiresAt).toBeUndefined();
  });

  it('excludes final shipments from accepted active trips', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { driverAssignment: { findMany } } as unknown as PrismaService;
    const service = new DataService(prisma);

    await service.list('active-trips', 'driver-1', 'DRIVER');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        driverId: 'driver-1',
        status: 'ACCEPTED',
        shipment: { status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED'] } },
      }),
    }));
  });

  it('reports each operations checkpoint instead of labelling every shipment in transit', async () => {
    const now = new Date('2026-09-23T10:00:00.000Z');
    const shipment = (id: string, status: string, adminApproved = false) => ({
      id,
      reference: `TRK-${id}`,
      customerId: 'customer-1',
      status,
      adminApproved,
      pickupAddress: 'Lagos',
      destinationAddress: 'Abuja',
      cargoDescription: 'Food',
      quotedPriceKobo: 100_000,
      updatedAt: now,
    });
    const prisma = {
      shipment: { findMany: jest.fn().mockResolvedValue([
        shipment('draft', 'DRAFT'),
        shipment('payment', 'PENDING_PAYMENT'),
        shipment('review', 'ESCROW_FUNDED'),
        shipment('ready', 'ESCROW_FUNDED', true),
        shipment('trip', 'PICKED_UP', true),
      ]) },
      driverAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new DataService(prisma);

    const result = await service.list('operation-shipments', 'admin-1', 'ADMIN');

    expect((result as Array<{ status: string }>).map((item) => item.status)).toEqual([
      'Draft',
      'Payment required',
      'Awaiting review',
      'Ready for assignment',
      'In transit',
    ]);
  });
});
