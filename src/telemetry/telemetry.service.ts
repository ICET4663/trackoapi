import { Injectable, Logger } from '@nestjs/common';
import { RateLimitService } from '../auth/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';

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
  ) {}

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
    return { received: true };
  }

  async recentClientErrors(limit = 50) {
    try {
      const rows = await this.prisma.auditLog.findMany({
        where: { action: 'CLIENT_ERROR' },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(1, limit), 200),
      });
      return rows.map((row) => {
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
    } catch (error) {
      this.logger.error(`recentClientErrors() failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}
