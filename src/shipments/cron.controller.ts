import { Controller, ForbiddenException, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/public.decorator';
import { TrackingService } from '../tracking/tracking.service';
import { ShipmentsService } from './shipments.service';

// Scheduled/system endpoints - never called by any client, only by Vercel Cron (see
// vercel.json). Vercel Cron always issues a GET request (not POST) carrying
// `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set on the project; without a
// configured secret this refuses every request rather than silently running unauthenticated.
@Controller('cron')
export class CronController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly tracking: TrackingService,
    private readonly config: ConfigService,
  ) {}

  @Get('escrow-auto-release')
  @Public()
  async autoReleaseEscrow(@Headers('authorization') authorization?: string) {
    this.assertScheduledJob(authorization);

    const [escrow, assignments] = await Promise.all([
      this.shipments.autoReleaseEligibleEscrows(),
      this.shipments.expireStaleAssignmentOffers(),
    ]);
    const matching = await this.shipments.matchWaitingShipments();
    // Housekeeping must never break escrow release or offer expiry, which share this run.
    const locationRetention = await this.tracking.purgeExpiredLocationHistory()
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    return { escrow, assignments, matching, locationRetention, ranAt: new Date().toISOString() };
  }

  // Every few minutes (GitHub Actions `dispatch-sweep.yml`; Vercel Hobby cron is daily only):
  // expire unanswered offers so they pass to the next driver, then offer waiting shipments.
  @Get('dispatch-sweep')
  @Public()
  async dispatchSweep(@Headers('authorization') authorization?: string) {
    this.assertScheduledJob(authorization);

    const assignments = await this.shipments.expireStaleAssignmentOffers();
    const matching = await this.shipments.matchWaitingShipments();
    return { assignments, matching, ranAt: new Date().toISOString() };
  }

  private assertScheduledJob(authorization?: string) {
    const expected = this.config.get<string>('CRON_SECRET');
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (!expected || !presented || !this.secretsMatch(expected, presented)) {
      throw new ForbiddenException('This endpoint is only reachable by the scheduled job.');
    }
  }

  private secretsMatch(expected: string, presented: string) {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const presentedBuffer = Buffer.from(presented, 'utf8');
    return expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
  }
}
