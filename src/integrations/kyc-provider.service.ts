import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VerificationStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { Consent, SmileID } from '@smileid/usesmileid-nodejs';
import { PrismaService } from '../prisma/prisma.service';
import { kycConfig } from '../config/kyc-config';

// Nigeria only supports automated ID-authority lookups for these id_type values
// (confirmed against Smile ID's Nigeria ID-type catalog) - PASSPORT and
// DRIVERS_LICENSE are not verifiable this way for NG, so those submissions stay
// on manual admin review only rather than pretending an automated check ran.
const NIGERIA_ID_TYPE_MAP: Record<string, string> = {
  NIN: 'NIN_V2',
  NATIONAL_ID_CARD: 'NIN_SLIP',
  VOTERS_CARD: 'VOTER_ID',
};

type VerifyIdentityInput = {
  submissionId: string;
  userId: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  idType: string;
  idNumber: string;
  bvn?: string | null;
};

type VerifyIdentityResult = {
  ran: boolean;
  jobId?: string;
  decision?: 'APPROVED' | 'CORRECTION_REQUIRED' | null;
  status?: string;
  message?: string;
  skippedReason?: string;
  error?: string;
};

@Injectable()
export class KycProviderService {
  private readonly logger = new Logger(KycProviderService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  status() {
    const readiness = kycConfig(this.config);
    const { provider, configured } = readiness;
    const hasSmileKey = Boolean(this.config.get<string>('SMILE_ID_API_KEY')) && Boolean(this.config.get<string>('SMILE_ID_PARTNER_ID'));

    return {
      provider,
      mode: configured ? 'configured' : 'mock',
      realVerificationEnabled: configured,
      productionReady: readiness.productionReady,
      missing: readiness.missing,
      // Surfaced so this doesn't stay an invisible gap the way the missing verification
      // itself did - false here means the webhook accepts nothing (fails closed), not
      // that it's open.
      webhookSecured: Boolean(this.config.get<string>('KYC_WEBHOOK_SECRET')) || hasSmileKey,
      automatedVerification: configured
        ? {
            enabled: true,
            environment: this.config.get<string>('SMILE_ID_ENVIRONMENT') ?? 'sandbox',
            callbackConfigured: Boolean(this.publicBaseUrl()),
            supportedIdTypes: Object.keys(NIGERIA_ID_TYPE_MAP).concat('BVN (any role, when provided)'),
            unsupportedIdTypes: ['INTL_PASSPORT', 'DRIVERS_LICENCE'],
          }
        : { enabled: false },
      requiredEnv:
        provider === 'dojah'
          ? ['DOJAH_API_KEY', 'DOJAH_APP_ID']
          : provider === 'mono'
            ? ['MONO_SECRET_KEY']
            : ['SMILE_ID_API_KEY', 'SMILE_ID_PARTNER_ID', 'SMILE_ID_CALLBACK_URL (or a Vercel deployment URL)'],
    };
  }

  async initiate(input: Record<string, unknown>) {
    const reference = `tracko_kyc_${Date.now()}`;
    const userId = String(input.userId ?? 'preview-customer');
    const submissionId = input.submissionId ? String(input.submissionId) : undefined;

    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: userId.startsWith('preview-') ? undefined : userId,
          action: 'KYC_PROVIDER_INITIATED',
          entity: 'KycSubmission',
          entityId: submissionId,
          metadata: this.toJson({
            provider: this.status().provider,
            reference,
            input,
          }),
        },
      });
    } catch {
      // Preview fallback below.
    }

    return {
      provider: this.status().provider,
      mode: this.status().mode,
      reference,
      submissionId,
      userId,
      redirectUrl: this.status().mode === 'mock' ? null : this.config.get<string>('KYC_PROVIDER_REDIRECT_URL') ?? null,
      message:
        this.status().mode === 'mock'
          ? 'Mock KYC provider initialized. Add provider keys before real identity checks.'
          : 'Smile ID automated verification is configured. Signed provider results complete verification.',
    };
  }

  private smileIdConfigured() {
    return kycConfig(this.config).configured;
  }

  private publicBaseUrl(): string | null {
    return kycConfig(this.config).callback;
  }

  private smileIdClient(): SmileID {
    return new SmileID({
      partnerId: this.config.get<string>('SMILE_ID_PARTNER_ID')!,
      apiKey: this.config.get<string>('SMILE_ID_API_KEY')!,
      environment: this.config.get<string>('SMILE_ID_ENVIRONMENT') === 'production' ? 'production' : 'sandbox',
      defaultCallbackUrl: `${this.publicBaseUrl()}/v1/kyc/provider/webhooks/smile_id/verification.completed`,
    });
  }

  // Picks the strongest available identifier Smile ID can actually check against
  // a Nigerian ID authority. BVN wins when present (it's the most universal
  // Nigerian identity check and doesn't depend on which document the applicant
  // picked). Returns null when nothing supplied is verifiable this way - see
  // NIGERIA_ID_TYPE_MAP's comment.
  private mapNigeriaIdentity(idType: string, idNumber: string, bvn?: string | null) {
    const cleanBvn = bvn?.replace(/\s+/g, '');
    if (cleanBvn) return { idType: 'BVN', idNumber: cleanBvn };
    const mapped = NIGERIA_ID_TYPE_MAP[idType];
    return mapped ? { idType: mapped, idNumber: idNumber.replace(/\s+/g, '') } : null;
  }

  // Runs a real Smile ID Enhanced KYC check (ID number against the issuing
  // authority) for one KYC submission. Never throws - a Smile ID outage or
  // misconfiguration must never block the underlying submission, which already
  // has manual admin review as its baseline (see KycService.decide()). This
  // only makes that baseline faster when Smile ID can decide quickly, or leaves
  // it untouched when it can't.
  async verifyIdentity(input: VerifyIdentityInput): Promise<VerifyIdentityResult> {
    if (!this.smileIdConfigured()) {
      return { ran: false, skippedReason: 'Smile ID is not configured (missing SMILE_ID_API_KEY/SMILE_ID_PARTNER_ID).' };
    }
    const identity = this.mapNigeriaIdentity(input.idType, input.idNumber, input.bvn);
    if (!identity) {
      return {
        ran: false,
        skippedReason: `Automated verification isn't available for ${input.idType} in Nigeria yet; this stays on manual review.`,
      };
    }
    const base = this.publicBaseUrl();
    if (!base) {
      return { ran: false, skippedReason: 'SMILE_ID_CALLBACK_URL is not set and no deployment URL was found.' };
    }
    if (!input.email && !input.phone) {
      return { ran: false, skippedReason: 'Smile ID requires an email or phone number on file to run an automated check.' };
    }

    const [givenNames, ...rest] = input.fullName.trim().split(/\s+/).filter(Boolean);
    const lastName = rest.join(' ') || givenNames || 'Trako User';

    const smile = this.smileIdClient();
    let jobId: string | null = null;

    try {
      const accepted = await smile.enhancedKyc.verify({
        country: 'NG',
        idType: identity.idType,
        idNumber: identity.idNumber,
        userId: input.userId,
        userDetails: {
          givenNames: givenNames || 'Trako',
          lastName,
          email: input.email ?? undefined,
          phoneNumber: input.phone ?? undefined,
        },
        consent: Consent.granted({
          grantedAt: new Date(),
          noticeLanguage: 'EN',
          noticePrivacyPolicyUrl: `${base}/v1/legal/privacy`,
        }),
        partnerParams: { submissionId: input.submissionId, userId: input.userId },
      });

      if (!accepted.isAccepted || !accepted.jobId) {
        throw new Error(accepted.message || 'Smile ID did not accept the verification job.');
      }
      jobId = accepted.jobId;
      await this.persistProviderJob(input.submissionId, jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Smile ID Enhanced KYC submission failed: ${message}`);
      await this.prisma.auditLog.create({
        data: {
          action: 'KYC_PROVIDER_SUBMIT_FAILED',
          entity: 'KycSubmission',
          entityId: input.submissionId,
          metadata: this.toJson({ provider: 'smile_id', error: message }),
        },
      }).catch(() => null);
      return { ran: false, error: message };
    }

    // Enhanced KYC is asynchronous - the webhook (recordSmileIdWebhook) is the sole
    // authoritative result. Deliberately not polling verifications.waitUntilComplete()
    // here: this method runs inside the KYC submission request, and a synchronous wait
    // risks exceeding the serverless function's own timeout (10s on Vercel's Hobby tier)
    // and killing the whole submission response after the DB write already succeeded.
    return { ran: true, jobId, decision: null };
  }

  private decisionForStatus(status: string): 'APPROVED' | 'CORRECTION_REQUIRED' | null {
    if (status === 'clear') return 'APPROVED';
    if (status === 'block') return 'CORRECTION_REQUIRED';
    return null;
  }

  // Smile ID's webhook signature (distinct from the generic shared-secret path
  // below): HMAC-SHA256, keyed on the API key, over
  // `${timestamp}${partnerId}sid_request`, base64-encoded. See "Validate the
  // webhook signature" in Smile ID's Verification Webhooks docs.
  private verifySmileIdSignature(timestamp?: string, signature?: string) {
    const partnerId = this.config.get<string>('SMILE_ID_PARTNER_ID');
    const apiKey = this.config.get<string>('SMILE_ID_API_KEY');
    if (!partnerId || !apiKey || !timestamp || !signature) return false;
    const digest = createHmac('sha256', apiKey).update(`${timestamp}${partnerId}sid_request`).digest('base64');
    try {
      const suppliedBuffer = Buffer.from(signature, 'base64');
      const digestBuffer = Buffer.from(digest, 'base64');
      return suppliedBuffer.length === digestBuffer.length && timingSafeEqual(suppliedBuffer, digestBuffer);
    } catch {
      return false;
    }
  }

  private async recordSmileIdWebhook(body: unknown, timestamp?: string, signature?: string) {
    const verified = this.verifySmileIdSignature(timestamp, signature);
    const payload = (body ?? {}) as {
      status?: string;
      message?: string;
      reason?: string | null;
      product?: string;
      partner_params?: { submissionId?: string; userId?: string };
    };
    const submissionId = payload.partner_params?.submissionId;
    const userId = payload.partner_params?.userId;
    let updated = false;
    const decision = verified ? this.decisionForStatus(String(payload.status ?? '')) : null;

    if (verified && submissionId) {
      try {
        await this.ensureProviderColumns();
        const note = this.noteForStatus(payload.status, payload.message, payload.reason);
        await this.prisma.$executeRawUnsafe(
          `update "KycSubmission"
           set "providerStatus" = $1, "providerReason" = $2, "providerCheckedAt" = current_timestamp,
               "note" = $3, "updatedAt" = current_timestamp
           where "id" = $4`,
          payload.status ?? null,
          payload.reason ?? payload.message ?? null,
          note,
          submissionId,
        );

        if (decision) {
          const verificationStatus: VerificationStatus = decision === 'APPROVED' ? 'VERIFIED' : 'ACTION_NEEDED';
          await this.prisma.$executeRawUnsafe(
            `update "KycSubmission"
             set "status" = $1::"KycSubmissionStatus", "reviewedAt" = current_timestamp,
                 "reviewedBy" = 'smile_id', "updatedAt" = current_timestamp
             where "id" = $2`,
            decision,
            submissionId,
          );
          if (userId) {
            await this.prisma.user.update({ where: { id: userId }, data: { verificationStatus } });
          }
          updated = true;
        }
      } catch (error) {
        this.logger.error(`Failed to apply Smile ID webhook result: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'KYC_WEBHOOK_RECEIVED',
        entity: 'KycProvider',
        entityId: submissionId ?? userId,
        metadata: this.toJson({ provider: 'smile_id', body, verified, updated, decision }),
      },
    }).catch(() => null);

    return {
      received: true,
      provider: 'smile_id',
      event: `verification.${payload.status ?? 'unknown'}`,
      verified,
      updated,
      processedAt: new Date().toISOString(),
    };
  }

  private noteForStatus(status?: string, message?: string, reason?: string | null) {
    const detail = message || reason || 'see provider notes';
    if (status === 'clear') return 'Automatically verified by Smile ID (government ID authority match).';
    if (status === 'block') return `Smile ID could not confirm this ID: ${detail}. Double-check the ID number and resubmit, or wait for manual review.`;
    if (status === 'attention') return `Smile ID flagged this submission for review: ${detail}.`;
    return `Smile ID could not complete an automated check: ${detail}. A reviewer will check this manually.`;
  }

  // This had NO signature/secret verification at all - unlike the Paystack webhook right
  // next to it in the same controller. Since this endpoint is @Public() (no session
  // required) and directly flips User.verificationStatus to VERIFIED based only on the
  // request body, anyone who could reach the API could POST
  // { userId: '<any account>', status: 'approved' } here and grant that account a real
  // KYC approval - completely bypassing identity verification, including the KYC gate on
  // funding escrow. Same constant-time shared-secret check as the cron endpoint, but
  // timing-safe (cron's own `!==` string compare is not).
  private verifyWebhookSecret(presented?: string) {
    const expected = this.config.get<string>('KYC_WEBHOOK_SECRET');
    if (!expected || !presented) return false;
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const presentedBuffer = Buffer.from(presented, 'utf8');
    return expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
  }

  async recordWebhook(
    provider: string,
    event: string,
    body: unknown,
    sharedSecret?: string,
    smileIdTimestamp?: string,
    smileIdSignature?: string,
  ) {
    if (provider === 'smile_id') {
      return this.recordSmileIdWebhook(body, smileIdTimestamp, smileIdSignature);
    }

    const verified = this.verifyWebhookSecret(sharedSecret);
    const result = this.extractKycResult(body);
    let updated = false;

    if (verified && (result.submissionId || result.userId)) {
      try {
        const submissionRows = await this.prisma.$queryRawUnsafe<{ id: string; userId: string }[]>(
          `update "KycSubmission"
           set "status" = cast($1 as "KycSubmissionStatus"),
               "note" = $2,
               "reviewedAt" = current_timestamp,
               "reviewedBy" = $3,
               "updatedAt" = current_timestamp
           where ($4::text is not null and "id" = $4)
              or ($5::text is not null and "userId" = $5)
           returning "id", "userId"`,
          result.status,
          result.note,
          provider,
          result.submissionId ?? null,
          result.userId ?? null,
        );
        const target = submissionRows[0];
        if (target) {
          await this.prisma.user.update({
            where: { id: target.userId },
            data: { verificationStatus: result.verificationStatus as VerificationStatus },
          });
          updated = true;
        }
      } catch {
        updated = false;
      }
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'KYC_WEBHOOK_RECEIVED',
          entity: 'KycProvider',
          entityId: result.submissionId ?? result.userId,
          metadata: this.toJson({ provider, event, body, result, verified, updated }),
        },
      });
    } catch {
      // Preview fallback below.
    }

    return {
      received: true,
      provider,
      event,
      verified,
      updated,
      processedAt: new Date().toISOString(),
    };
  }

  private extractKycResult(body: unknown) {
    const payload = (body ?? {}) as {
      submissionId?: string;
      userId?: string;
      status?: string;
      result?: string;
      data?: {
        submissionId?: string;
        userId?: string;
        status?: string;
        result?: string;
      };
    };
    const rawStatus = String(payload.status ?? payload.result ?? payload.data?.status ?? payload.data?.result ?? '').toLowerCase();
    const approved = ['approved', 'verified', 'success', 'passed'].includes(rawStatus);
    const rejected = ['rejected', 'failed', 'declined'].includes(rawStatus);
    return {
      submissionId: payload.submissionId ?? payload.data?.submissionId,
      userId: payload.userId ?? payload.data?.userId,
      status: approved ? 'APPROVED' : rejected ? 'REJECTED' : 'CORRECTION_REQUIRED',
      verificationStatus: approved ? 'VERIFIED' : rejected ? 'REJECTED' : 'ACTION_NEEDED',
      note: approved
        ? 'KYC approved by provider.'
        : rejected
          ? 'KYC rejected by provider.'
          : 'KYC provider requested correction or manual review.',
    };
  }

  async ensureProviderColumns() {
    await this.prisma.$executeRawUnsafe(`alter table "KycSubmission" add column if not exists "providerJobId" text`);
    await this.prisma.$executeRawUnsafe(`alter table "KycSubmission" add column if not exists "providerStatus" text`);
    await this.prisma.$executeRawUnsafe(`alter table "KycSubmission" add column if not exists "providerReason" text`);
    await this.prisma.$executeRawUnsafe(`alter table "KycSubmission" add column if not exists "providerCheckedAt" timestamp(3)`);
    await this.prisma.$executeRawUnsafe(`create index if not exists "KycSubmission_providerJobId_idx" on "KycSubmission"("providerJobId")`);
  }

  private async persistProviderJob(submissionId: string, jobId: string) {
    await this.ensureProviderColumns();
    await this.prisma.$executeRawUnsafe(
      `update "KycSubmission" set "providerJobId" = $1, "updatedAt" = current_timestamp where "id" = $2`,
      jobId,
      submissionId,
    );
    await this.prisma.auditLog.create({
      data: {
        action: 'KYC_PROVIDER_SUBMITTED',
        entity: 'KycSubmission',
        entityId: submissionId,
        metadata: this.toJson({ provider: 'smile_id', jobId }),
      },
    }).catch(() => null);
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
