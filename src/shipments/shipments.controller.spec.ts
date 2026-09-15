import type { AuthUser } from '../common/types/auth-user';
import { RequestUserService } from '../common/request-user.service';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

describe('ShipmentsController escrow role routing', () => {
  const actor = (role: AuthUser['role']): AuthUser => ({
    sub: `${role.toLowerCase()}-1`,
    email: `${role.toLowerCase()}@tracko.ng`,
    role,
    verificationStatus: 'VERIFIED',
  });

  function setup(role: AuthUser['role']) {
    const shipments = {
      confirmEscrowCheck: jest.fn().mockResolvedValue({ status: 'FUNDED' }),
      releaseEscrow: jest.fn().mockResolvedValue({ status: 'RELEASED' }),
      refundEscrow: jest.fn().mockResolvedValue({ status: 'REFUNDED' }),
    } as unknown as ShipmentsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue(actor(role)),
    } as unknown as RequestUserService;
    return {
      controller: new ShipmentsController(shipments, requestUser),
      shipments: shipments as unknown as {
        confirmEscrowCheck: jest.Mock;
        releaseEscrow: jest.Mock;
        refundEscrow: jest.Mock;
      },
      requestUser: requestUser as unknown as { requireRole: jest.Mock },
    };
  }

  it('passes the authenticated driver role to the arrival confirmation', async () => {
    const { controller, shipments, requestUser } = setup('DRIVER');

    await controller.confirmEscrowCheck('shipment-1', 'arrivalConfirmed', 'Bearer token');

    expect(requestUser.requireRole).toHaveBeenCalledWith('Bearer token', ['CUSTOMER', 'DRIVER', 'DISPATCHER', 'ADMIN']);
    expect(shipments.confirmEscrowCheck).toHaveBeenCalledWith('shipment-1', 'arrivalConfirmed', 'DRIVER');
  });

  it('passes the authenticated admin role to platform approval', async () => {
    const { controller, shipments } = setup('ADMIN');

    await controller.confirmEscrowCheck('shipment-1', 'platformApproved', 'Bearer token');

    expect(shipments.confirmEscrowCheck).toHaveBeenCalledWith('shipment-1', 'platformApproved', 'ADMIN');
  });

  it('allows admin or dispatcher sessions to release and refund escrow', async () => {
    const { controller, shipments, requestUser } = setup('ADMIN');

    await controller.releaseEscrow('shipment-1', { note: 'Approved.' }, 'Bearer token');
    await controller.refundEscrow('shipment-1', { note: 'Refunded.' }, 'Bearer token');

    expect(requestUser.requireRole).toHaveBeenCalledTimes(2);
    expect(requestUser.requireRole).toHaveBeenCalledWith('Bearer token', ['ADMIN', 'DISPATCHER']);
    expect(shipments.releaseEscrow).toHaveBeenCalledWith('shipment-1', 'ADMIN', 'Approved.');
    expect(shipments.refundEscrow).toHaveBeenCalledWith('shipment-1', 'ADMIN', 'Refunded.');
  });
});
