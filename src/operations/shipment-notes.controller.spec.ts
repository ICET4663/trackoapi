import { ForbiddenException } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { ShipmentNotesController } from './shipment-notes.controller';
import { ShipmentNotesService } from './shipment-notes.service';

describe('ShipmentNotesController', () => {
  const actor = { sub: 'staff-1', role: 'DISPATCHER' };
  const notes = { list: jest.fn(), append: jest.fn() };
  const auth = { requireRole: jest.fn() };
  let controller: ShipmentNotesController;

  beforeEach(() => {
    jest.resetAllMocks();
    auth.requireRole.mockResolvedValue(actor);
    controller = new ShipmentNotesController(notes as unknown as ShipmentNotesService, auth as unknown as RequestUserService);
  });

  it('requires staff authentication for reads', async () => {
    await controller.list('shipment-1', 'Bearer staff-token');
    expect(auth.requireRole).toHaveBeenCalledWith('Bearer staff-token', ['ADMIN', 'DISPATCHER']);
    expect(notes.list).toHaveBeenCalledWith('shipment-1', actor);
  });

  it('takes author identity from authentication, not the request body', async () => {
    await controller.append('shipment-1', { body: 'Call pickup contact' }, 'Bearer staff-token');
    expect(notes.append).toHaveBeenCalledWith('shipment-1', 'Call pickup contact', actor);
  });

  it('does not access notes when authentication fails', async () => {
    auth.requireRole.mockRejectedValue(new ForbiddenException());
    await expect(controller.list('shipment-1', 'Bearer customer')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.append('shipment-1', { body: 'Note' }, 'Bearer customer')).rejects.toBeInstanceOf(ForbiddenException);
    expect(notes.list).not.toHaveBeenCalled();
    expect(notes.append).not.toHaveBeenCalled();
  });
});

