import { ForbiddenException } from '@nestjs/common';
import { CronController } from './cron.controller';
import type { ShipmentsService } from './shipments.service';
import type { ConfigService } from '@nestjs/config';

// This endpoint is reachable without a bearer token (@Public()) since Vercel Cron cannot
// send a normal user JWT - CRON_SECRET is the only thing standing between the public
// internet and triggering escrow releases on a schedule. These tests pin down that a
// missing/wrong secret is refused, and that a real request never runs unauthenticated.
describe('CronController.autoReleaseEscrow requires a real CRON_SECRET', () => {
  function buildController(configuredSecret: string | undefined) {
    const autoReleaseEligibleEscrows = jest.fn().mockResolvedValue({ candidateCount: 0, releasedCount: 0, results: [] });
    const shipments = { autoReleaseEligibleEscrows } as unknown as ShipmentsService;
    const config = { get: () => configuredSecret } as unknown as ConfigService;
    return { controller: new CronController(shipments, config), autoReleaseEligibleEscrows };
  }

  it('refuses the request outright when CRON_SECRET is not configured at all', async () => {
    const { controller, autoReleaseEligibleEscrows } = buildController(undefined);

    await expect(controller.autoReleaseEscrow('Bearer anything')).rejects.toBeInstanceOf(ForbiddenException);
    expect(autoReleaseEligibleEscrows).not.toHaveBeenCalled();
  });

  it('refuses a request with a missing or wrong bearer token', async () => {
    const { controller, autoReleaseEligibleEscrows } = buildController('the-real-secret');

    await expect(controller.autoReleaseEscrow(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.autoReleaseEscrow('Bearer wrong-secret')).rejects.toBeInstanceOf(ForbiddenException);
    expect(autoReleaseEligibleEscrows).not.toHaveBeenCalled();
  });

  it('runs the real auto-release job when the bearer token matches CRON_SECRET', async () => {
    const { controller, autoReleaseEligibleEscrows } = buildController('the-real-secret');

    await controller.autoReleaseEscrow('Bearer the-real-secret');

    expect(autoReleaseEligibleEscrows).toHaveBeenCalledTimes(1);
  });
});
