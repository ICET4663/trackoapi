import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// Backed by RateLimitBucket in Postgres, not an in-memory Map: on Vercel serverless each
// invocation can land on a different, memory-isolated instance, so an in-memory counter
// doesn't reliably limit anything - a caller retried enough times would just keep
// landing on fresh instances with an empty map. The upsert below is a single atomic
// statement (Postgres row-level lock on the ON CONFLICT path) so concurrent requests
// for the same key can't race each other into both being allowed.
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async assertAllowed(key: string, options: { limit: number; windowMs?: number; label: string }) {
    const windowMs =
      options.windowMs ?? Number(this.config.get<string>('AUTH_RATE_LIMIT_WINDOW_MS') ?? 15 * 60 * 1000);
    const newResetAt = new Date(Date.now() + windowMs);

    let row: { count: number; resetAt: Date } | undefined;
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ count: number; resetAt: Date }[]>(
        `insert into "RateLimitBucket" ("key", "count", "resetAt")
         values ($1, 1, $2)
         on conflict ("key") do update set
           "count" = case when "RateLimitBucket"."resetAt" <= now() then 1 else "RateLimitBucket"."count" + 1 end,
           "resetAt" = case when "RateLimitBucket"."resetAt" <= now() then excluded."resetAt" else "RateLimitBucket"."resetAt" end
         returning "count", "resetAt"`,
        key,
        newResetAt,
      );
      row = rows[0];
    } catch (error) {
      // The rate-limit store being briefly unreachable must not lock every caller out of
      // auth entirely - fail open, same "infra failure vs real business-rule failure"
      // distinction used everywhere else in this codebase. Logged so a persistently
      // failing store (meaning rate limiting is effectively off) is still visible.
      this.logger.error(`assertAllowed(${key}) could not reach the rate-limit store, failing open: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!row) return;

    if (row.count > options.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(row.resetAt).getTime() - Date.now()) / 1000));
      throw new HttpException(
        {
          message: `${options.label} rate limit reached. Try again later.`,
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
