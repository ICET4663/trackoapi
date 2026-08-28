import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type IntegrationReadiness = {
  name: string;
  mode: 'mock' | 'configured';
  missing: string[];
};

@Injectable()
export class DeploymentConfigService {
  constructor(private readonly config: ConfigService) {}

  summary() {
    const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
    const missingRequired = required.filter((key) => !this.hasValue(key));
    const integrations = this.integrations();

    return {
      environment: this.config.get<string>('NODE_ENV') ?? 'development',
      service: 'tracko-api',
      port: Number(this.config.get('PORT') ?? 4000),
      required: {
        ok: missingRequired.length === 0,
        missing: missingRequired,
      },
      integrations,
      deployable: missingRequired.length === 0,
      checkedAt: new Date().toISOString(),
    };
  }

  assertRequired() {
    const summary = this.summary();
    if (!summary.required.ok && this.isProduction()) {
      throw new Error(`Missing required environment variables: ${summary.required.missing.join(', ')}`);
    }
    return summary;
  }

  private integrations(): IntegrationReadiness[] {
    return [
      {
        name: 'payments',
        mode: this.hasAny(['PAYSTACK_SECRET_KEY', 'STRIPE_SECRET_KEY']) ? 'configured' : 'mock',
        missing: this.config.get<string>('PAYMENT_PROVIDER') === 'stripe' ? this.missing(['STRIPE_SECRET_KEY']) : this.missing(['PAYSTACK_SECRET_KEY']),
      },
      {
        name: 'kyc',
        mode: this.hasAny(['SMILE_ID_API_KEY', 'DOJAH_API_KEY', 'MONO_SECRET_KEY']) ? 'configured' : 'mock',
        missing: this.missing(['SMILE_ID_API_KEY', 'SMILE_ID_PARTNER_ID']),
      },
      {
        name: 'maps',
        mode: this.hasValue('GOOGLE_MAPS_API_KEY') ? 'configured' : 'mock',
        missing: this.missing(['GOOGLE_MAPS_API_KEY']),
      },
      {
        // GET /v1/cron/escrow-auto-release (see vercel.json) always refuses every request
        // when this is unset, rather than silently running unauthenticated or no-op - so
        // "mock" here genuinely means the scheduled auto-release job cannot run at all yet.
        name: 'scheduledEscrowAutoRelease',
        mode: this.hasValue('CRON_SECRET') ? 'configured' : 'mock',
        missing: this.missing(['CRON_SECRET']),
      },
    ];
  }

  private missing(keys: string[]) {
    return keys.filter((key) => !this.hasValue(key));
  }

  private hasAny(keys: string[]) {
    return keys.some((key) => this.hasValue(key));
  }

  private hasValue(key: string) {
    const value = this.config.get<string>(key);
    return Boolean(value && value.trim() && !value.includes('replace-with') && !value.includes('[YOUR-'));
  }

  private isProduction() {
    return this.config.get<string>('NODE_ENV') === 'production';
  }
}
