import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { KycService } from './kyc.service';

@Controller()
export class KycController {
  constructor(
    private readonly kycService: KycService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('kyc')
  async myKyc(@Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.kycService.myKyc(user.sub);
  }

  @Post('kyc')
  async submit(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization, 'CUSTOMER');
    return this.kycService.submit(body, user.sub, user.role);
  }

  @Get('admin/verifications')
  queue() {
    return this.kycService.queue();
  }

  @Get('admin/verifications/:userId')
  review(@Param('userId') userId: string) {
    return this.kycService.review(userId);
  }

  @Post('admin/verifications/:userId')
  decide(@Param('userId') userId: string, @Body() body: { action?: 'APPROVE' | 'REQUEST_CORRECTION' | 'REJECT'; note?: string }) {
    return this.kycService.decide(userId, body);
  }
}
