import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';

describe('shipment timeline transition guards', () => {
  function setup() {
    const prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ id: 'shipment-1',
        customerId: 'customer-1', status: 'DRIVER_EN_ROUTE',
        assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }] }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'timeline-1', status: 'ARRIVED_PICKUP', note: 'Test', createdAt: new Date() }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    const service = new ShipmentsService(prisma as any, {} as any, {} as any);
    return { service, prisma };
  }
  it('blocks a customer advancing driver status before any writes', async () => {
    const { service, prisma } = setup();
    await expect(service.addTimelineEvent('shipment-1', 'customer-1', 'CUSTOMER', { status: 'ARRIVED_PICKUP' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  it('blocks a driver skipping straight to delivery', async () => {
    const { service, prisma } = setup();
    await expect(service.addTimelineEvent('shipment-1', 'driver-1', 'DRIVER', { status: 'DELIVERED' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('allows the assigned driver to follow the next transition', async () => {
    const { service, prisma } = setup();
    await service.addTimelineEvent('shipment-1', 'driver-1', 'DRIVER', { status: 'ARRIVED_PICKUP' });
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
  it('still permits same-status customer notes', async () => {
    const { service, prisma } = setup();
    await service.addTimelineEvent('shipment-1', 'customer-1', 'CUSTOMER', { note: 'Pickup instructions' });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
  it('operations cannot skip the lifecycle either', async () => {
    const { service, prisma } = setup();
    await expect(service.addTimelineEvent('shipment-1', 'admin-1', 'ADMIN', { status: 'COMPLETED' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});