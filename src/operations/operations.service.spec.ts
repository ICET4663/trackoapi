import { ForbiddenException } from '@nestjs/common';
import { OperationsService } from './operations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ShipmentsService } from '../shipments/shipments.service';

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
    service = new OperationsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService, {} as ShipmentsService);
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

// resolveDispute() set the shipment's displayed status to COMPLETED/CANCELLED and told
// the customer "resolved" for a RELEASE/REFUND decision, but never touched the Escrow
// record itself - the money's own tracked state silently never changed. These tests pin
// down that the real escrow-mutation methods are actually called, and in the right order
// (before the dispute is marked resolved, so a failure there leaves the dispute open
// rather than falsely "resolved").
describe('OperationsService.resolveDispute wires decisions to real escrow mutations', () => {
  let prisma: { $executeRawUnsafe: jest.Mock; shipment: { findFirst: jest.Mock; update: jest.Mock }; auditLog: { create: jest.Mock } };
  let notifications: { create: jest.Mock };
  let shipments: { releaseEscrow: jest.Mock; refundEscrow: jest.Mock };
  let service: OperationsService;
  const actor: OperationActor = { sub: 'admin-1', role: 'ADMIN' };
  const shipmentRow = { id: 'shp-1', reference: 'TRK-1', customerId: 'cust-1' };

  beforeEach(() => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      shipment: { findFirst: jest.fn().mockResolvedValue(shipmentRow), update: jest.fn().mockResolvedValue(undefined) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    shipments = { releaseEscrow: jest.fn().mockResolvedValue({ status: 'RELEASED' }), refundEscrow: jest.fn().mockResolvedValue({ status: 'REFUNDED' }) };
    service = new OperationsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService, shipments as unknown as ShipmentsService);
  });

  it('calls the real releaseEscrow for a RELEASE decision, and does not also manually overwrite the shipment status', async () => {
    await service.resolveDispute('dsp-1', { shipmentId: 'TRK-1', decision: 'RELEASE', resolution: 'Delivery confirmed.' }, actor);

    expect(shipments.releaseEscrow).toHaveBeenCalledWith('shp-1', 'ADMIN', 'Delivery confirmed.');
    expect(shipments.refundEscrow).not.toHaveBeenCalled();
    // releaseEscrow() already updates the shipment's status/timeline internally.
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('calls the real refundEscrow for a REFUND decision', async () => {
    await service.resolveDispute('dsp-1', { shipmentId: 'TRK-1', decision: 'REFUND', resolution: 'Shipment cancelled.' }, actor);

    expect(shipments.refundEscrow).toHaveBeenCalledWith('shp-1', 'ADMIN', 'Shipment cancelled.');
    expect(shipments.releaseEscrow).not.toHaveBeenCalled();
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });

  it('never touches escrow for a decision that is neither RELEASE nor REFUND', async () => {
    await service.resolveDispute('dsp-1', { shipmentId: 'TRK-1', decision: 'RESUME', resolution: 'Investigation ongoing.' }, actor);

    expect(shipments.releaseEscrow).not.toHaveBeenCalled();
    expect(shipments.refundEscrow).not.toHaveBeenCalled();
    expect(prisma.shipment.update).toHaveBeenCalledTimes(1);
  });

  it('leaves the dispute unresolved if the escrow mutation itself fails', async () => {
    shipments.releaseEscrow.mockRejectedValue(new Error('escrow already disputed'));

    await expect(service.resolveDispute('dsp-1', { shipmentId: 'TRK-1', decision: 'RELEASE', resolution: 'x' }, actor)).rejects.toThrow('escrow already disputed');
    // The dispute row must never be marked RESOLVED when the financial action it
    // represents never actually happened.
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
