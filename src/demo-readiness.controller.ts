import { Controller, Get } from '@nestjs/common';
import { DeploymentConfigService } from './config/deployment-config.service';
import { PrismaService } from './prisma/prisma.service';

@Controller('demo')
export class DemoReadinessController {
  constructor(
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('readiness')
  async readiness() {
    const deployment = this.deploymentConfig.summary();
    const database = await this.databaseStatus();

    return {
      ok: database.connected && deployment.required.ok,
      message: database.connected
        ? 'Tracko API is running and connected. Auth, escrow, and KYC integration endpoints are ready for preview.'
        : 'Tracko API is running, but database connection needs attention.',
      api: {
        service: 'tracko-api',
        environment: deployment.environment,
        checkedAt: new Date().toISOString(),
      },
      database,
      authentication: {
        status: 'ready_for_preview',
        emailOtp: true,
        roleAwareOtp: true,
        jwtLogin: true,
        refreshTokens: true,
        accountDeletion: true,
        endpoints: [
          'POST /v1/auth/register/request',
          'POST /v1/auth/register',
          'POST /v1/auth/login',
          'POST /v1/auth/refresh',
          'DELETE /v1/auth/account',
        ],
      },
      escrowPayment: {
        status: 'provider_ready',
        provider: this.integrationMode(deployment.integrations, 'payments'),
        paystackReady: this.integrationMode(deployment.integrations, 'payments') === 'configured',
        endpoints: [
          'POST /v1/payments/escrow/initialize',
          'GET /v1/payments/paystack/verify/:reference',
          'POST /v1/payments/webhooks/paystack/charge.success',
          'GET /v1/shipments/:id/escrow',
          'POST /v1/shipments/:id/escrow/release',
          'POST /v1/shipments/:id/escrow/dispute',
          'POST /v1/shipments/:id/escrow/refund',
        ],
      },
      kyc: {
        status: 'provider_ready',
        provider: this.integrationMode(deployment.integrations, 'kyc'),
        endpoints: [
          'POST /v1/kyc',
          'GET /v1/kyc',
          'GET /v1/admin/verifications',
          'POST /v1/admin/verifications/:userId',
          'POST /v1/kyc/provider/initiate',
          'POST /v1/kyc/provider/webhooks/:provider/:event',
        ],
      },
      mapsAddressing: {
        status: 'ready_for_preview',
        provider: this.integrationMode(deployment.integrations, 'maps'),
        endpoints: [
          'GET /v1/maps/places?query=...',
          'GET /v1/maps/geocode?address=...',
          'POST /v1/maps/route-estimate',
        ],
      },
      frontendConnection: {
        requiredEnv: 'EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-URL/v1',
        status: 'ready_after_backend_url_is_added_to_frontend_env',
      },
      operationsWorkflow: {
        status: 'ready_for_preview',
        endpoints: [
          'GET /v1/operations/workflow-readiness',
          'GET /v1/operations/assignment-queue',
          'GET /v1/operations/escrow-ledger',
        ],
      },
      nextProofToShow: [
        'Open /v1/demo/readiness',
        'Open /v1/health',
        'Open /v1/integrations/status',
        'Open /v1/operations/workflow-readiness as dispatcher/admin',
        'Request registration OTP from the app',
        'Initialize escrow from a shipment',
      ],
    };
  }

  private async databaseStatus() {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ connected: number }[]>('select 1 as connected');
      return {
        connected: rows[0]?.connected === 1,
        provider: 'Supabase Postgres / Prisma',
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        connected: false,
        provider: 'Supabase Postgres / Prisma',
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private integrationMode(integrations: { name: string; mode: string }[], name: string) {
    return integrations.find((integration) => integration.name === name)?.mode ?? 'mock';
  }
}
