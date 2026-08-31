import { Controller, ForbiddenException, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/public.decorator';
import { ShipmentsService } from './shipments.service';

// Scheduled/system endpoints - never called by any client, only by Vercel Cron (see
// vercel.json). Vercel Cron always issues a GET request (not POST) carrying
// `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set on the project; without a
// configured secret this refuses every request rather than silently running unauthenticated.
@Controller('cron')
export class CronController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly config: ConfigService,
  ) {}

  @Get('escrow-auto-release')
  @Public()
  async autoReleaseEscrow(@Headers('authorization') authorization?: string) {
    const expected = this.config.get<string>('CRON_SECRET');
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (!expected || !presented || !this.secretsMatch(expected, presented)) {
      throw new ForbiddenException('This endpoint is only reachable by the scheduled job.');
    }

    const [escrow, assignments] = await Promise.all([
      this.shipments.autoReleaseEligibleEscrows(),
      this.shipments.expireStaleAssignmentOffers(),
    ]);
    return { escrow, assignments, ranAt: new Date().toISOString() };
  }

  private secretsMatch(expected: string, presented: string) {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const presentedBuffer = Buffer.from(presented, 'utf8');
    return expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
  }
}
