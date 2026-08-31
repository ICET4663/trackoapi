import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VerificationStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class KycProviderService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  status() {
    const provider = this.config.get<string>('KYC_PROVIDER') ?? 'mock';
    const hasSmileKey = Boolean(this.config.get<string>('SMILE_ID_API_KEY'));
    const hasDojahKey = Boolean(this.config.get<string>('DOJAH_API_KEY'));
    const hasMonoKey = Boolean(this.config.get<string>('MONO_SECRET_KEY'));
    const configured = hasSmileKey || hasDojahKey || hasMonoKey;

    return {
      provider,
      mode: configured ? 'configured' : 'mock',
      realVerificationEnabled: configured,
      // Surfaced so this doesn't stay an invisible gap the way the missing verification
      // itself did - false here means the webhook accepts nothing (fails closed), not
      // that it's open.
      webhookSecured: Boolean(this.config.get<string>('KYC_WEBHOOK_SECRET')),
      requiredEnv:
        provider === 'dojah'
          ? ['DOJAH_API_KEY', 'DOJAH_APP_ID']
          : provider === 'mono'
            ? ['MONO_SECRET_KEY']
            : ['SMILE_ID_API_KEY', 'SMILE_ID_PARTNER_ID'],
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
          : 'Provider credentials found. Connect the provider SDK/API in this service before live verification.',
    };
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

  async recordWebhook(provider: string, event: string, body: unknown, sharedSecret?: string) {
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

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
