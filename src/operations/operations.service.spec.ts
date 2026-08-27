import { ForbiddenException } from '@nestjs/common';
import { OperationsService } from './operations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

type OperationActor = { sub: string; role: 'ADMIN' | 'DISPATCHER' | 'DRIVER' | 'CUSTOMER' | 'TRUCK_OWNER'; email?: string };

// progressTrip previously let any authenticated driver account advance (including
// marking DELIVERED/COMPLETED, which feeds escrow release) a shipment they were never
// assigned to - it only checked the caller's role, not that a DRIVER caller actually
// held an ACCEPTED DriverAssignment for that specific shipment. These tests pin that
// fix in place.
describe('OperationsService.progressTrip', () => {
  let prisma: {
    driverAssignment: { findFirst: jest.Mock };
    shipment: { update: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let notifications: { create: jest.Mock };
  let service: OperationsService;

  const shipmentRow = {
    id: 'shp-1',
    reference: 'TRK-1',
    customerId: 'cust-1',
    status: 'IN_TRANSIT',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    timeline: [],
  };

  beforeEach(() => {
    prisma = {
      driverAssignment: { findFirst: jest.fn() },
      shipment: { update: jest.fn().mockResolvedValue(shipmentRow) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    service = new OperationsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  });

  it('rejects a DRIVER with no ACCEPTED assignment on the shipment, and never touches the shipment row', async () => {
    prisma.driverAssignment.findFirst.mockResolvedValue(null);
    const actor: OperationActor = { sub: 'driver-not-assigned', role: 'DRIVER' };

    await expect(service.progressTrip('shp-1', { status: 'DELIVERED' }, actor)).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.driverAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shipmentId: 'shp-1', driverId: 'driver-not-assigned', status: 'ACCEPTED' } }),
    );
    // The whole point of the fix: an unauthorized attempt must never reach the write.
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('allows a DRIVER who holds an ACCEPTED assignment on this exact shipment', async () => {
    prisma.driverAssignment.findFirst.mockResolvedValue({ id: 'assign-1' });
    const actor: OperationActor = { sub: 'driver-assigned', role: 'DRIVER' };

    const result = await service.progressTrip('shp-1', { status: 'ARRIVED_DESTINATION' }, actor);

    expect(prisma.shipment.update).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('shp-1');
  });

  it('allows ADMIN to progress a trip without any assignment lookup at all', async () => {
    const actor: OperationActor = { sub: 'admin-1', role: 'ADMIN' };

    await service.progressTrip('shp-1', { status: 'DELIVERED' }, actor);

    expect(prisma.driverAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.shipment.update).toHaveBeenCalledTimes(1);
  });

  it('allows DISPATCHER to progress a trip without any assignment lookup at all', async () => {
    const actor: OperationActor = { sub: 'dispatch-1', role: 'DISPATCHER' };

    await service.progressTrip('shp-1', { status: 'PICKED_UP' }, actor);

    expect(prisma.driverAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.shipment.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a CUSTOMER outright, before any assignment lookup or write', async () => {
    const actor: OperationActor = { sub: 'cust-1', role: 'CUSTOMER' };

    await expect(service.progressTrip('shp-1', { status: 'DELIVERED' }, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.driverAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('treats an infra failure looking up the assignment as "not assigned", not as a bypass', async () => {
    prisma.driverAssignment.findFirst.mockRejectedValue(new Error('connection reset'));
    const actor: OperationActor = { sub: 'driver-1', role: 'DRIVER' };

    await expect(service.progressTrip('shp-1', { status: 'DELIVERED' }, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });
});
