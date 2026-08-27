import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service';
import type { PrismaService } from '../prisma/prisma.service';

// Was an in-memory Map, which doesn't reliably limit anything on Vercel serverless -
// each invocation can land on a different, memory-isolated instance. Now backed by a
// shared RateLimitBucket row via a single atomic upsert. These tests exercise the
// service's own logic against a mocked query result, not real Postgres CASE-expression
// behaviour (that's exercised by the SQL itself, not unit-testable without a live DB).
describe('RateLimitService', () => {
  let config: { get: jest.Mock };
  let prisma: { $queryRawUnsafe: jest.Mock };
  let service: RateLimitService;

  beforeEach(() => {
    config = { get: jest.fn().mockReturnValue(undefined) };
    prisma = { $queryRawUnsafe: jest.fn() };
    service = new RateLimitService(config as unknown as ConfigService, prisma as unknown as PrismaService);
  });

  it('allows the call through when the returned count is within the limit', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ count: 3, resetAt: new Date(Date.now() + 60_000) }]);

    await expect(
      service.assertAllowed('login:test@example.com', { limit: 5, label: 'Login' }),
    ).resolves.toBeUndefined();
  });

  it('throws 429 with a retryAfterSeconds once the count exceeds the limit', async () => {
    const resetAt = new Date(Date.now() + 45_000);
    prisma.$queryRawUnsafe.mockResolvedValue([{ count: 6, resetAt }]);

    const attempt = service.assertAllowed('login:test@example.com', { limit: 5, label: 'Login' });
    await expect(attempt).rejects.toBeInstanceOf(HttpException);

    try {
      await service.assertAllowed('login:test@example.com', { limit: 5, label: 'Login' });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const response = (error as HttpException).getResponse() as { retryAfterSeconds: number };
      expect(response.retryAfterSeconds).toBeGreaterThan(0);
      expect(response.retryAfterSeconds).toBeLessThanOrEqual(45);
    }
  });

  it('passes the key and a computed reset timestamp to the upsert', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ count: 1, resetAt: new Date() }]);

    await service.assertAllowed('register-otp:a@b.com:CUSTOMER', { limit: 3, windowMs: 60_000, label: 'Registration' });

    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('insert into "RateLimitBucket"'),
      'register-otp:a@b.com:CUSTOMER',
      expect.any(Date),
    );
  });

  it('fails open (does not throw) when the rate-limit store is unreachable', async () => {
    prisma.$queryRawUnsafe.mockRejectedValue(new Error('connection reset'));

    // A caller must never be locked out of login/registration just because the shared
    // counter store had a brief outage - that would turn an availability blip into an
    // authentication outage.
    await expect(
      service.assertAllowed('login:test@example.com', { limit: 5, label: 'Login' }),
    ).resolves.toBeUndefined();
  });
});
