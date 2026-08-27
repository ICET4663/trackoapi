import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { RequestUserService } from '../common/request-user.service';
import { KycProviderService } from './kyc-provider.service';
import { MapsProviderService } from './maps-provider.service';
import { PaymentProviderService } from './payment-provider.service';

@Controller()
export class IntegrationsController {
  constructor(
    private readonly kycProvider: KycProviderService,
    private readonly mapsProvider: MapsProviderService,
    private readonly paymentProvider: PaymentProviderService,
    private readonly requestUser: RequestUserService,
  ) {}

  @Get('integrations/status')
  status() {
    return {
      kyc: this.kycProvider.status(),
      payments: this.paymentProvider.status(),
      maps: this.mapsProvider.status(),
    };
  }

  // Proxies a paid Google Places/Geocoding call - requiring a session (any role) prevents
  // anonymous callers from running up the API bill for free.
  @Get('maps/places')
  async places(@Query('query') query: string | undefined, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.mapsProvider.places(query ?? '');
  }

  @Get('maps/geocode')
  async geocode(@Query('address') address: string | undefined, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.mapsProvider.geocode(address ?? '');
  }

  @Post('maps/route-estimate')
  async routeEstimate(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.mapsProvider.routeEstimate({
      originLatitude: Number(body.originLatitude ?? body.originLat),
      originLongitude: Number(body.originLongitude ?? body.originLng),
      destinationLatitude: Number(body.destinationLatitude ?? body.destinationLat),
      destinationLongitude: Number(body.destinationLongitude ?? body.destinationLng),
      truckType: typeof body.truckType === 'string' ? body.truckType : undefined,
      weightTons: Number(body.weightTons),
    });
  }

  @Post('payments/escrow/initialize')
  async initializeEscrow(
    @Body() body: { shipmentId?: string; amount?: number; currency?: string; customerEmail?: string; method?: 'card' | 'bank_transfer' },
    @Headers('authorization') authorization?: string,
  ) {
    const user = await this.requestUser.requireRole(authorization, ['CUSTOMER']);
    return this.paymentProvider.initializeEscrow({
      ...body,
      customerId: user.sub,
      customerEmail: user.email,
    });
  }

  @Get('payments/paystack/verify/:reference')
  async verifyPaystackPayment(@Param('reference') reference: string, @Headers('authorization') authorization?: string) {
    await this.requestUser.fromAuthorizationHeader(authorization);
    return this.paymentProvider.verifyPaystackPayment(reference);
  }

  // Paystack calls this with no user session - protected by HMAC signature verification
  // inside recordWebhook() instead of a bearer token.
  @Post('payments/webhooks/:provider/:event')
  @Public()
  paymentWebhook(
    @Param('provider') provider: string,
    @Param('event') event: string,
    @Body() body: unknown,
    @Headers('x-paystack-signature') paystackSignature?: string,
    @Req() request?: Request & { rawBody?: Buffer },
  ) {
    return this.paymentProvider.recordWebhook(provider, event, body, paystackSignature, request?.rawBody);
  }

  @Post('kyc/provider/initiate')
  async initiateKyc(@Body() body: Record<string, unknown>, @Headers('authorization') authorization?: string) {
    const user = await this.requestUser.fromAuthorizationHeader(authorization);
    return this.kycProvider.initiate({ ...body, userId: user.sub });
  }

  // Same as the payment webhook - an external KYC provider callback, no user session.
  @Post('kyc/provider/webhooks/:provider/:event')
  @Public()
  kycWebhook(@Param('provider') provider: string, @Param('event') event: string, @Body() body: unknown) {
    return this.kycProvider.recordWebhook(provider, event, body);
  }
}
