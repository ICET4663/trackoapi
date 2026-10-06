import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from '../auth/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';
import { fatalAlertConfig } from '../config/fatal-alert-config';

type ClientErrorInput = {
  message?: unknown;
  stack?: unknown;
  componentStack?: unknown;
  screen?: unknown;
  appVersion?: unknown;
  platform?: unknown;
  fatal?: unknown;
};

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  private async sendFatalAlert(message: string, input: ClientErrorInput, actorId?: string) {
    const channels = fatalAlertConfig(this.config);
    if (!channels.configured) return;
    const fingerprint = message.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 120) || 'unknown';
    try {
      await this.rateLimit.assertAllowed(`client-error-alert:${fingerprint}`, {
        limit: 1,
        windowMs: 15 * 60 * 1000,
        label: 'Fatal error alert',
      });
      const payload = {
        text: `Trako fatal client error: ${message}`,
        event: 'TRAKO_FATAL_CLIENT_ERROR',
        message,
        actorId: actorId ?? null,
        screen: str(input.screen, 200) ?? null,
        appVersion: str(input.appVersion, 40) ?? null,
        platform: str(input.platform, 40) ?? null,
        occurredAt: new Date().toISOString(),
      };
      const requests: Promise<Response>[] = [];
      if (channels.webhook) requests.push(fetch(channels.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4_000),
      }));
      if (channels.email) requests.push(fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${channels.email.apiKey}` },
        body: JSON.stringify({
          from: channels.email.from,
          to: [channels.email.recipient],
          subject: 'Trako: fatal application error',
          text: `${payload.text}\nScreen: ${payload.screen ?? 'unknown'}\nPlatform: ${payload.platform ?? 'unknown'}\nVersion: ${payload.appVersion ?? 'unknown'}\nTime: ${payload.occurredAt}\nReview the admin error log for details.`,
        }),
        signal: AbortSignal.timeout(4_000),
      }));
      for (const result of await Promise.allSettled(requests)) {
        if (result.status === 'rejected' || !result.value.ok) {
          this.logger.warn(`Fatal error alert channel failed${result.status === 'fulfilled' ? ` (HTTP ${result.value.status})` : ''}.`);
        }
      }
    } catch (error) {
      // A duplicate alert, network outage or webhook failure must never affect the app.
      this.logger.warn(`Fatal error alert was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Sink for client-side crash/error reports. Rate-limited per identity so a
  // client stuck in an error loop can't flood; the audit write itself is
  // best-effort so telemetry never turns into a client-facing failure.
  async recordClientError(input: ClientErrorInput, actorId?: string) {
    await this.rateLimit.assertAllowed(`client-error:${actorId ?? 'anon'}`, {
      limit: 30,
      windowMs: 5 * 60 * 1000,
      label: 'Error reporting',
    });

    const message = str(input.message, 500) ?? 'Unknown client error';
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actorId ?? null,
          action: 'CLIENT_ERROR',
          entity: 'Client',
          entityId: str(input.screen, 120) ?? null,
          metadata: {
            message,
            stack: str(input.stack, 4000) ?? null,
            componentStack: str(input.componentStack, 4000) ?? null,
            screen: str(input.screen, 200) ?? null,
            appVersion: str(input.appVersion, 40) ?? null,
            platform: str(input.platform, 40) ?? null,
            fatal: input.fatal === true,
          },
        },
      });
    } catch (error) {
      this.logger.error(`recordClientError() could not persist "${message}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (input.fatal === true) await this.sendFatalAlert(message, input, actorId);
    return { received: true };
  }

  async recentClientErrors(limit = 50, viewerId?: string) {
    try {
      const rows = await this.prisma.auditLog.findMany({
        where: { action: 'CLIENT_ERROR' },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(1, limit), 200),
      });
      const mapped = rows.map((row) => {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          id: row.id,
          at: row.createdAt.toISOString(),
          actorId: row.actorId,
          message: typeof meta.message === 'string' ? meta.message : 'Unknown client error',
          screen: typeof meta.screen === 'string' ? meta.screen : null,
          platform: typeof meta.platform === 'string' ? meta.platform : null,
          appVersion: typeof meta.appVersion === 'string' ? meta.appVersion : null,
          fatal: meta.fatal === true,
          stack: typeof meta.stack === 'string' ? meta.stack : null,
          componentStack: typeof meta.componentStack === 'string' ? meta.componentStack : null,
        };
      });
      if (viewerId) {
        await this.prisma.auditLog.create({
          data: {
            actorId: viewerId,
            action: 'CLIENT_ERROR_LOG_VIEWED',
            entity: 'Telemetry',
            metadata: { returned: mapped.length, requestedLimit: Math.min(Math.max(1, limit), 200) },
          },
        }).catch(() => null);
      }
      return mapped;
    } catch (error) {
      this.logger.error(`recentClientErrors() failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}
