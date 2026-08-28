import { Controller, ForbiddenException, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    if (!expected || presented !== expected) {
      throw new ForbiddenException('This endpoint is only reachable by the scheduled job.');
    }

    return this.shipments.autoReleaseEligibleEscrows();
  }
}
