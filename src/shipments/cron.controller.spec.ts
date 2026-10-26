import { ForbiddenException } from '@nestjs/common';
import { CronController } from './cron.controller';
import type { ShipmentsService } from './shipments.service';
import type { TrackingService } from '../tracking/tracking.service';
import type { ConfigService } from '@nestjs/config';

// This endpoint is reachable without a bearer token (@Public()) since Vercel Cron cannot
// send a normal user JWT - CRON_SECRET is the only thing standing between the public
// internet and triggering escrow releases on a schedule. These tests pin down that a
// missing/wrong secret is refused, and that a real request never runs unauthenticated.
describe('CronController.autoReleaseEscrow requires a real CRON_SECRET', () => {
  function buildController(configuredSecret: string | undefined) {
    const autoReleaseEligibleEscrows = jest.fn().mockResolvedValue({ candidateCount: 0, releasedCount: 0, results: [] });
    const expireStaleAssignmentOffers = jest.fn().mockResolvedValue({ expiredCount: 0, validityMinutes: 15 });
    const matchWaitingShipments = jest.fn().mockResolvedValue({ waiting: 0, offered: 0 });
    const shipments = { autoReleaseEligibleEscrows, expireStaleAssignmentOffers, matchWaitingShipments } as unknown as ShipmentsService;
    const purgeExpiredLocationHistory = jest.fn().mockResolvedValue({ retentionDays: 30, deleted: 0 });
    const tracking = { purgeExpiredLocationHistory } as unknown as TrackingService;
    const config = { get: () => configuredSecret } as unknown as ConfigService;
    return { controller: new CronController(shipments, tracking, config), autoReleaseEligibleEscrows, expireStaleAssignmentOffers, matchWaitingShipments, purgeExpiredLocationHistory };
  }

  it('refuses the request outright when CRON_SECRET is not configured at all', async () => {
    const { controller, autoReleaseEligibleEscrows, expireStaleAssignmentOffers } = buildController(undefined);

    await expect(controller.autoReleaseEscrow('Bearer anything')).rejects.toBeInstanceOf(ForbiddenException);
    expect(autoReleaseEligibleEscrows).not.toHaveBeenCalled();
    expect(expireStaleAssignmentOffers).not.toHaveBeenCalled();
  });

  it('refuses a request with a missing or wrong bearer token', async () => {
    const { controller, autoReleaseEligibleEscrows, expireStaleAssignmentOffers } = buildController('the-real-secret');

    await expect(controller.autoReleaseEscrow(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.autoReleaseEscrow('Bearer wrong-secret')).rejects.toBeInstanceOf(ForbiddenException);
    expect(autoReleaseEligibleEscrows).not.toHaveBeenCalled();
    expect(expireStaleAssignmentOffers).not.toHaveBeenCalled();
  });

  it('runs the real auto-release job when the bearer token matches CRON_SECRET', async () => {
    const { controller, autoReleaseEligibleEscrows, expireStaleAssignmentOffers } = buildController('the-real-secret');

    await controller.autoReleaseEscrow('Bearer the-real-secret');

    expect(autoReleaseEligibleEscrows).toHaveBeenCalledTimes(1);
    expect(expireStaleAssignmentOffers).toHaveBeenCalledTimes(1);
  });

  it('purges expired location history as part of the same scheduled run', async () => {
    const { controller, purgeExpiredLocationHistory } = buildController('the-real-secret');

    const result = await controller.autoReleaseEscrow('Bearer the-real-secret');

    expect(purgeExpiredLocationHistory).toHaveBeenCalledTimes(1);
    expect(result.locationRetention).toEqual({ retentionDays: 30, deleted: 0 });
  });

  it('never lets a failed purge stop escrow release or offer expiry from reporting their results', async () => {
    const { controller, purgeExpiredLocationHistory, autoReleaseEligibleEscrows } = buildController('the-real-secret');
    purgeExpiredLocationHistory.mockRejectedValue(new Error('db busy'));

    const result = await controller.autoReleaseEscrow('Bearer the-real-secret');

    expect(autoReleaseEligibleEscrows).toHaveBeenCalledTimes(1);
    expect(result.locationRetention).toEqual({ error: 'db busy' });
    expect(result.escrow).toBeDefined();
  });

  it('does not purge anything for an unauthenticated request', async () => {
    const { controller, purgeExpiredLocationHistory } = buildController('the-real-secret');

    await expect(controller.autoReleaseEscrow('Bearer wrong')).rejects.toBeInstanceOf(ForbiddenException);
    expect(purgeExpiredLocationHistory).not.toHaveBeenCalled();
  });
});

describe('CronController.dispatchSweep', () => {
  function buildController(configuredSecret: string | undefined) {
    const calls: string[] = [];
    const expireStaleAssignmentOffers = jest.fn(async () => { calls.push('expire'); return { expiredCount: 1, validityMinutes: 15 }; });
    const matchWaitingShipments = jest.fn(async () => { calls.push('match'); return { waiting: 2, offered: 1 }; });
    const shipments = { expireStaleAssignmentOffers, matchWaitingShipments } as unknown as ShipmentsService;
    const config = { get: () => configuredSecret } as unknown as ConfigService;
    return { controller: new CronController(shipments, {} as TrackingService, config), calls, expireStaleAssignmentOffers, matchWaitingShipments };
  }

  it('refuses a missing secret, a missing token and a wrong token', async () => {
    const cases: Array<[string | undefined, string | undefined]> = [[undefined, 'Bearer x'], ['the-real-secret', undefined], ['the-real-secret', 'Bearer wrong']];
    for (const [secret, header] of cases) {
      const { controller, expireStaleAssignmentOffers, matchWaitingShipments } = buildController(secret);
      await expect(controller.dispatchSweep(header)).rejects.toBeInstanceOf(ForbiddenException);
      expect(expireStaleAssignmentOffers).not.toHaveBeenCalled();
      expect(matchWaitingShipments).not.toHaveBeenCalled();
    }
  });

  it('expires unanswered offers before offering waiting shipments', async () => {
    const { controller, calls } = buildController('the-real-secret');

    const result = await controller.dispatchSweep('Bearer the-real-secret');

    expect(calls).toEqual(['expire', 'match']);
    expect(result).toMatchObject({ assignments: { expiredCount: 1 }, matching: { waiting: 2, offered: 1 } });
  });
});

describe('CronController daily run offers waiting shipments', () => {
  it('matches waiting shipments after expiring offers', async () => {
    const matchWaitingShipments = jest.fn().mockResolvedValue({ waiting: 1, offered: 1 });
    const controller = new CronController(
      {
        autoReleaseEligibleEscrows: jest.fn().mockResolvedValue({}),
        expireStaleAssignmentOffers: jest.fn().mockResolvedValue({}),
        matchWaitingShipments,
      } as unknown as ShipmentsService,
      { purgeExpiredLocationHistory: jest.fn().mockResolvedValue({}) } as unknown as TrackingService,
      { get: () => 'the-real-secret' } as unknown as ConfigService,
    );

    const result = await controller.autoReleaseEscrow('Bearer the-real-secret');

    expect(matchWaitingShipments).toHaveBeenCalledTimes(1);
    expect(result.matching).toEqual({ waiting: 1, offered: 1 });
  });
});
