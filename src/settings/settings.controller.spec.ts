import type { RequestUserService } from '../common/request-user.service';
import { SettingsController } from './settings.controller';
import type { SettingsService } from './settings.service';

describe('SettingsController payout authorization', () => {
  it('reserves payout decisions for an authenticated admin', async () => {
    const settings = {
      reviewPayoutRequest: jest.fn().mockResolvedValue({ id: 'payout-1', status: 'APPROVED' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'admin-1', role: 'ADMIN' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.reviewPayoutRequest('payout-1', { decision: 'APPROVED' }, 'Bearer token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer token', ['ADMIN']);
    expect((settings as unknown as { reviewPayoutRequest: jest.Mock }).reviewPayoutRequest)
      .toHaveBeenCalledWith('payout-1', 'admin-1', { decision: 'APPROVED' });
  });
});

describe('SettingsController owner fleet assignment', () => {
  it('requires a truck-owner session and passes the authenticated owner id to the service', async () => {
    const settings = {
      assignDriverToOwnedVehicle: jest.fn().mockResolvedValue({ id: 'vehicle-1', assignedDriverId: 'driver-1' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'owner-1', role: 'TRUCK_OWNER' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.assignDriverToOwnedVehicle({ vehicleId: 'vehicle-1', driverId: 'driver-1' }, 'Bearer owner-token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer owner-token', ['TRUCK_OWNER']);
    expect((settings as unknown as { assignDriverToOwnedVehicle: jest.Mock }).assignDriverToOwnedVehicle)
      .toHaveBeenCalledWith('vehicle-1', 'driver-1', 'owner-1');
  });
});

describe('SettingsController owner settlements', () => {
  it('requires a truck-owner session for earnings and withdrawal requests', async () => {
    const settings = {
      ownerEarnings: jest.fn().mockResolvedValue({ availableBalance: 0 }),
      requestOwnerWithdrawal: jest.fn().mockResolvedValue({ id: 'payout-1' }),
    } as unknown as SettingsService;
    const requestUser = {
      requireRole: jest.fn().mockResolvedValue({ sub: 'owner-1', role: 'TRUCK_OWNER' }),
    } as unknown as RequestUserService;
    const controller = new SettingsController(settings, requestUser);

    await controller.ownerEarnings('Bearer owner-token');
    await controller.requestOwnerWithdrawal({ amountKobo: 100_000 }, 'Bearer owner-token');

    expect((requestUser as unknown as { requireRole: jest.Mock }).requireRole)
      .toHaveBeenCalledWith('Bearer owner-token', ['TRUCK_OWNER']);
    expect((settings as unknown as { ownerEarnings: jest.Mock }).ownerEarnings).toHaveBeenCalledWith('owner-1');
    expect((settings as unknown as { requestOwnerWithdrawal: jest.Mock }).requestOwnerWithdrawal)
      .toHaveBeenCalledWith('owner-1', { amountKobo: 100_000 });
  });
});
