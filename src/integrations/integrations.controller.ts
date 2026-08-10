import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
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

  @Get('maps/places')
  places(@Query('query') query?: string) {
    return this.mapsProvider.places(query ?? '');
  }

  @Get('maps/geocode')
  geocode(@Query('address') address?: string) {
    return this.mapsProvider.geocode(address ?? '');
  }

  @Post('maps/route-estimate')
  routeEstimate(@Body() body: Record<string, unknown>) {
    return this.mapsProvider.routeEstimate({
      originLatitude: Number(body.originLatitude ?? body.originLat),
      originLongitude: Number(body.originLongitude ?? body.originLng),
      destinationLatitude: Number(body.destinationLatitude ?? body.destinationLat),
      destinationLongitude: Number(body.destinationLongitude ?? body.destinationLng),
      truckType: typeof body.truckType === 'string' ? body.truckType : undefined,
    });
  }

  @Post('payments/escrow/initialize')
  async initializeEscrow(
    @Body() body: { shipmentId?: string; amount?: number; currency?: string; customerEmail?: string },
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
  verifyPaystackPayment(@Param('reference') reference: string) {
    return this.paymentProvider.verifyPaystackPayment(reference);
  }

  @Post('payments/webhooks/:provider/:event')
  paymentWebhook(
    @Param('provider') provider: string,
    @Param('event') event: string,
    @Body() body: unknown,
    @Headers('x-paystack-signature') paystackSignature?: string,
  ) {
    return this.paymentProvider.recordWebhook(provider, event, body, paystackSignature);
  }

  @Post('kyc/provider/initiate')
  initiateKyc(@Body() body: Record<string, unknown>) {
    return this.kycProvider.initiate(body);
  }

  @Post('kyc/provider/webhooks/:provider/:event')
  kycWebhook(@Param('provider') provider: string, @Param('event') event: string, @Body() body: unknown) {
    return this.kycProvider.recordWebhook(provider, event, body);
  }
}
