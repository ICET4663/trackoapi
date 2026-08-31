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
    // Env-var presence only, kept fast and synchronous like every other entry here - this
    // runs on every cold boot (see create-app.ts). Whether Resend's sending domain is
    // actually *verified* (vs. just an API key existing, which still only sends to your
    // own inbox in sandbox mode) needs a live Resend API call - see emailDomainStatus()
    // below, called separately by the health/readiness endpoints only.

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
      {
        // "configured" here only means the API key exists and OTP/notification emails can
        // be sent at all - Resend still runs in sandbox mode (deliverable only to the
        // account owner's own inbox) until a sending domain is added and verified. See
        // emailDomainStatus() for the real, live answer to "can this actually reach users".
        name: 'email',
        mode: this.hasValue('RESEND_API_KEY') ? 'configured' : 'mock',
        missing: this.missing(['RESEND_API_KEY']),
      },
    ];
  }

  // A live call to Resend's own API - env vars alone can't tell you whether a domain has
  // actually finished DNS verification, only whether an API key exists. Called on-demand
  // by the health/readiness endpoints, never at bootstrap (an external API call has no
  // place blocking every cold start for a non-critical status check).
  async emailDomainStatus(): Promise<{
    checked: boolean;
    verifiedDomains: string[];
    pendingDomains: string[];
    message: string;
  }> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      return { checked: false, verifiedDomains: [], pendingDomains: [], message: 'RESEND_API_KEY is not set.' };
    }

    try {
      const response = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const payload = (await response.json().catch(() => null)) as { data?: { name: string; status: string }[] } | null;
      if (!response.ok || !payload?.data) {
        return { checked: false, verifiedDomains: [], pendingDomains: [], message: `Resend API returned ${response.status}.` };
      }

      const verifiedDomains = payload.data.filter((domain) => domain.status === 'verified').map((domain) => domain.name);
      const pendingDomains = payload.data.filter((domain) => domain.status !== 'verified').map((domain) => domain.name);
      const message = verifiedDomains.length
        ? `Sending as ${verifiedDomains.join(', ')} - real emails can reach any recipient.`
        : pendingDomains.length
          ? `${pendingDomains.join(', ')} added but not yet verified - still sandbox-only (your own inbox) until DNS records are confirmed.`
          : 'No domain added yet in Resend - still sandbox-only (your own inbox).';
      return { checked: true, verifiedDomains, pendingDomains, message };
    } catch (error) {
      return { checked: false, verifiedDomains: [], pendingDomains: [], message: error instanceof Error ? error.message : String(error) };
    }
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
