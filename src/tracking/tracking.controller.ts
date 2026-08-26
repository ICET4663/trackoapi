import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RequestUserService } from '../common/request-user.service';
import { TrackingService } from './tracking.service';

@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly tracking: TrackingService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('shipments/:id')
  async currentLocation(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.tracking.currentLocation(id, user);
  }

  @Get('shipments/:id/history')
  async locationHistory(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.tracking.locationHistory(id, user);
  }

  @Post('shipments/:id/location')
  async recordLocation(
    @Param('id') id: string,
    @Body() body: { latitude?: number; longitude?: number; heading?: number; speedKph?: number; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    return this.tracking.recordLocation(id, user, body);
  }

  @Get('shipments/:id/proof-of-delivery')
  async deliveryProofs(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.tracking.deliveryProofs(id, user);
  }

  @Post('shipments/:id/proof-of-delivery')
  async submitDeliveryProof(
    @Param('id') id: string,
    @Body() body: { photoUrl?: string; signatureUrl?: string; recipientName?: string; note?: string },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['DRIVER']);
    return this.tracking.submitDeliveryProof(id, user, body);
  }
}
