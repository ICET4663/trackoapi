import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { KycProviderService } from './kyc-provider.service';
import { PaymentProviderService } from './payment-provider.service';

@Controller()
export class IntegrationsController {
  constructor(
    private readonly kycProvider: KycProviderService,
    private readonly paymentProvider: PaymentProviderService,
  ) {}

  @Get('integrations/status')
  status() {
    return {
      kyc: this.kycProvider.status(),
      payments: this.paymentProvider.status(),
      maps: {
        provider: 'mock',
        mode: 'mock',
        realRoutingEnabled: false,
        requiredEnv: ['GOOGLE_MAPS_API_KEY'],
      },
    };
  }

  @Post('payments/escrow/initialize')
  initializeEscrow(@Body() body: { shipmentId?: string; amount?: number; currency?: string; customerEmail?: string }) {
    return this.paymentProvider.initializeEscrow(body);
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
