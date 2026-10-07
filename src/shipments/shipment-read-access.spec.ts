import { ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';
import type { RequestUserService } from '../common/request-user.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

describe('shipment-linked read authorization', () => {
  for (const endpoint of ['getEscrow', 'getReview'] as const) {
    it(`${endpoint} authorizes before reading linked data`, async () => {
      const get = jest.fn().mockResolvedValue({ id: 'shipment-1' });
      const linked = jest.fn().mockResolvedValue({ id: 'linked' });
      const service = { get, [endpoint]: linked } as unknown as ShipmentsService;
      const users = { fromAuthorizationHeader: jest.fn().mockResolvedValue({ sub: 'user-1', role: 'CUSTOMER' }) } as unknown as RequestUserService;
      await new ShipmentsController(service, users)[endpoint]('shipment-1', 'Bearer token');
      expect(get).toHaveBeenCalledWith('shipment-1', 'user-1', 'CUSTOMER');
      expect(get.mock.invocationCallOrder[0]).toBeLessThan(linked.mock.invocationCallOrder[0]);
    });
    for (const failure of [new ForbiddenException(), new NotFoundException(), new InternalServerErrorException()]) {
      it(`${endpoint} blocks disclosure after ${failure.constructor.name}`, async () => {
        const linked = jest.fn();
        const service = { get: jest.fn().mockRejectedValue(failure), [endpoint]: linked } as unknown as ShipmentsService;
        const users = { fromAuthorizationHeader: jest.fn().mockResolvedValue({ sub: 'outsider', role: 'CUSTOMER' }) } as unknown as RequestUserService;
        await expect(new ShipmentsController(service, users)[endpoint]('shipment-1')).rejects.toBe(failure);
        expect(linked).not.toHaveBeenCalled();
      });
    }
  }
  const row = { id: 'shipment-1', customerId: 'customer-1', assignments: [{ driverId: 'driver-1', vehicle: { ownerId: 'owner-1' } }], timeline: [] };
  function setup(value: unknown = row) {
    const prisma = { shipment: { findUnique: jest.fn().mockResolvedValue(value) } } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);
    jest.spyOn(service as unknown as { toShipmentRecord: (value: unknown) => unknown }, 'toShipmentRecord').mockReturnValue({ id: 'shipment-1' });
    return service;
  }
  it.each([
    ['customer-1', 'CUSTOMER'], ['driver-1', 'DRIVER'], ['owner-1', 'TRUCK_OWNER'],
    ['operations-1', 'ADMIN'], ['dispatch-1', 'DISPATCHER'],
  ] as const)('allows linked actor %s (%s)', async (id, role) => {
    await expect(setup().get('shipment-1', id, role)).resolves.toEqual({ id: 'shipment-1' });
  });
  it.each(['CUSTOMER', 'DRIVER', 'TRUCK_OWNER'] as const)('rejects unrelated %s', async role => {
    await expect(setup().get('shipment-1', 'outsider', role)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('does not grant owner access when vehicle is missing', async () => {
    const service = setup({ ...row, assignments: [{ driverId: 'driver-1', vehicle: null }] });
    await expect(service.get('shipment-1', 'owner-1', 'TRUCK_OWNER')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

