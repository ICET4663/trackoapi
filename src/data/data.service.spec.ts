import { ForbiddenException } from '@nestjs/common';
import { DataService, type DataCollection } from './data.service';
import type { PrismaService } from '../prisma/prisma.service';

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
  });

  it('does not gate a self-scoped collection like customer-shipments for a CUSTOMER', async () => {
    // Sanity check that the ops-only gate is additive, not a blanket lockdown - every
    // role must still reach its own legitimately-scoped data.
    await expect(service.list('customer-shipments', 'cust-1', 'CUSTOMER')).resolves.toBeDefined();
    expect(prisma.shipment.findMany).toHaveBeenCalledTimes(1);
  });
});
