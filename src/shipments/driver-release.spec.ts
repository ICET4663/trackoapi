import { BadRequestException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// Found by the live exception run on 14 October: a paid shipment went back to QUOTED (the
// pre-payment state) whenever its driver declined or an offer was withdrawn, and operations
// had no way to take an accepted driver off a job (breakdown, driver unreachable).
describe('ShipmentsService when a driver drops off a shipment', () => {
  function build({ assignmentStatus = 'OFFERED', shipmentStatus = 'DRIVER_ASSIGNED', escrowStatus = 'FUNDED' as string | null } = {}) {
    const assignment = {
      id: 'asg-1', shipmentId: 'shp-1', driverId: 'driver-1', status: assignmentStatus,
      shipment: { id: 'shp-1', customerId: 'cust-1', reference: 'TRK-1', status: shipmentStatus, timeline: [] },
      driver: { profile: null }, vehicle: null,
    };
    const shipmentUpdate = jest.fn().mockResolvedValue({});
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const notificationsCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      driverAssignment: { findUnique: jest.fn().mockResolvedValue(assignment), updateMany, findFirst: jest.fn().mockResolvedValue(null) },
      shipment: { update: shipmentUpdate },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $queryRawUnsafe: jest.fn((sql: string) => Promise.resolve(sql.includes('from "Escrow"') && escrowStatus ? [{ status: escrowStatus }] : [])),
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, { create: notificationsCreate } as unknown as NotificationsService, {} as MapsProviderService);
    const internals = service as unknown as Record<string, unknown>;
    jest.spyOn(internals as never, 'offerNextEligibleDriver' as never).mockResolvedValue(null as never);
    jest.spyOn(internals as never, 'assignmentOfferValidityMinutes' as never).mockResolvedValue(15 as never);
    jest.spyOn(internals as never, 'toAssignmentRecord' as never).mockReturnValue({ id: 'asg-1' } as never);
    jest.spyOn(internals as never, 'activateQueuedOffers' as never).mockResolvedValue(undefined as never);
    const statusSetTo = () => (shipmentUpdate.mock.calls.at(-1)?.[0] as { data: { status: string } } | undefined)?.data.status;
    return { service, shipmentUpdate, updateMany, notificationsCreate, statusSetTo };
  }

  it('a paid shipment stays "payment held, awaiting a driver" when the driver declines', async () => {
    const { service, statusSetTo } = build();

    await service.respondToAssignment('asg-1', 'driver-1', 'REJECT');
    expect(statusSetTo()).toBe('ESCROW_FUNDED');
  });

  it('an unpaid shipment still goes back to quoted when the driver declines', async () => {
    const { service, statusSetTo } = build({ escrowStatus: 'PENDING' });

    await service.respondToAssignment('asg-1', 'driver-1', 'REJECT');
    expect(statusSetTo()).toBe('QUOTED');
  });

  it('withdrawing a pending offer on a paid shipment keeps it paid', async () => {
    const { service, statusSetTo } = build();

    await service.cancelAssignment('asg-1', 'disp-1', 'DISPATCHER');
    expect(statusSetTo()).toBe('ESCROW_FUNDED');
  });

  it.each(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED_PICKUP'])('operations can take an accepted driver off the job while %s', async (shipmentStatus) => {
    const { service, updateMany, statusSetTo, notificationsCreate } = build({ assignmentStatus: 'ACCEPTED', shipmentStatus });

    await service.cancelAssignment('asg-1', 'disp-1', 'DISPATCHER');
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'asg-1', status: 'ACCEPTED' }, data: expect.objectContaining({ status: 'CANCELLED' }) }));
    expect(statusSetTo()).toBe('ESCROW_FUNDED');
    expect(notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'Removed from shipment' }));
  });

  it.each(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'])('an accepted driver cannot be taken off once the cargo is on board (%s)', async (shipmentStatus) => {
    const { service, updateMany } = build({ assignmentStatus: 'ACCEPTED', shipmentStatus });

    await expect(service.cancelAssignment('asg-1', 'disp-1', 'DISPATCHER')).rejects.toBeInstanceOf(BadRequestException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('a declined or expired assignment cannot be withdrawn again', async () => {
    const { service, updateMany } = build({ assignmentStatus: 'REJECTED' });

    await expect(service.cancelAssignment('asg-1', 'disp-1', 'DISPATCHER')).rejects.toBeInstanceOf(BadRequestException);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
