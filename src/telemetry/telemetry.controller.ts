import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { RequestUserService } from '../common/request-user.service';
import { TelemetryService } from './telemetry.service';

@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly requestUser: RequestUserService,
  ) {}

  // Public so the app can report a crash even when the failure is in the auth/session
  // layer itself. Attributed to a user only when a valid token happens to ride along.
  @Post('client-errors')
  @Public()
  async reportClientError(
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    const actor = await this.requestUser.optionalFromAuthorizationHeader(authorization);
    return this.telemetry.recordClientError(body ?? {}, actor?.sub);
  }

  @Get('client-errors')
  async listClientErrors(
    @Query('limit') limit?: string,
    @Headers('authorization') authorization?: string,
  ) {
    await this.requestUser.requireRole(authorization, ['ADMIN']);
    const parsed = Number(limit);
    return this.telemetry.recentClientErrors(Number.isFinite(parsed) ? parsed : 50);
  }
}
