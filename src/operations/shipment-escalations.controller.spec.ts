import { ForbiddenException } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { ShipmentEscalationsController } from './shipment-escalations.controller';
import { ShipmentEscalationsService } from './shipment-escalations.service';

describe('ShipmentEscalationsController', () => {
  const actor = { sub: 'staff-1', role: 'DISPATCHER' };
  const escalations = { queue: jest.fn(), resolve: jest.fn(), listForShipment: jest.fn(), raise: jest.fn() };
  const auth = { requireRole: jest.fn() };
  let controller: ShipmentEscalationsController;

  beforeEach(() => {
    jest.resetAllMocks();
    auth.requireRole.mockResolvedValue(actor);
    controller = new ShipmentEscalationsController(escalations as unknown as ShipmentEscalationsService, auth as unknown as RequestUserService);
  });

  it('lets operations staff read and raise, with identity from the token', async () => {
    await controller.queue('OPEN', 'Bearer t');
    await controller.listForShipment('TRK-1', 'Bearer t');
    await controller.raise('TRK-1', { reason: 'Pickup contact unreachable' }, 'Bearer t');
    expect(auth.requireRole).toHaveBeenCalledTimes(3);
    for (const call of auth.requireRole.mock.calls) expect(call).toEqual(['Bearer t', ['ADMIN', 'DISPATCHER']]);
    expect(escalations.raise).toHaveBeenCalledWith('TRK-1', 'Pickup contact unreachable', actor);
  });

  it('requires an admin to resolve', async () => {
    await controller.resolve('esc-1', { note: 'Rebooked with the customer' }, 'Bearer t');
    expect(auth.requireRole).toHaveBeenCalledWith('Bearer t', ['ADMIN']);
    expect(escalations.resolve).toHaveBeenCalledWith('esc-1', 'Rebooked with the customer', actor);
  });

  it('does nothing when authentication fails', async () => {
    auth.requireRole.mockRejectedValue(new ForbiddenException());
    await expect(controller.raise('TRK-1', { reason: 'x'.repeat(20) }, 'Bearer customer')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.resolve('esc-1', { note: 'x'.repeat(20) }, 'Bearer customer')).rejects.toBeInstanceOf(ForbiddenException);
    expect(escalations.raise).not.toHaveBeenCalled();
    expect(escalations.resolve).not.toHaveBeenCalled();
  });
});
