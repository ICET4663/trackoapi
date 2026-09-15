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
