import type { RateLimitService } from '../auth/rate-limit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from './telemetry.service';

describe('TelemetryService', () => {
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock } };
  let rateLimit: { assertAllowed: jest.Mock };
  let service: TelemetryService;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) } };
    rateLimit = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
    service = new TelemetryService(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
    );
  });

  describe('recordClientError', () => {
    it('writes a CLIENT_ERROR audit row with truncated, sanitised fields', async () => {
      await service.recordClientError(
        {
          message: '  Cannot read property x of undefined  ',
          stack: 'x'.repeat(9000),
          screen: '/customer/wallet',
          appVersion: '1.4.0',
          platform: 'ios',
          fatal: true,
        },
        'user-1',
      );

      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const data = prisma.auditLog.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ actorId: 'user-1', action: 'CLIENT_ERROR', entity: 'Client' });
      expect(data.metadata.message).toBe('Cannot read property x of undefined');
      expect(data.metadata.stack.length).toBe(4000);
      expect(data.metadata.screen).toBe('/customer/wallet');
      expect(data.metadata.fatal).toBe(true);
    });

    it('rate-limits per identity before writing', async () => {
      await service.recordClientError({ message: 'boom' }, 'user-9');
      expect(rateLimit.assertAllowed).toHaveBeenCalledWith(
        'client-error:user-9',
        expect.objectContaining({ limit: expect.any(Number) }),
      );
    });

    it('uses an anon key when no actor is supplied', async () => {
      await service.recordClientError({ message: 'boom' });
      expect(rateLimit.assertAllowed).toHaveBeenCalledWith('client-error:anon', expect.anything());
      expect(prisma.auditLog.create.mock.calls[0][0].data.actorId).toBeNull();
    });

    it('propagates a rate-limit rejection and does not write', async () => {
      rateLimit.assertAllowed.mockRejectedValue(new Error('429'));
      await expect(service.recordClientError({ message: 'boom' }, 'u1')).rejects.toThrow('429');
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('never throws to the caller when the audit write fails', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('db down'));
      await expect(service.recordClientError({ message: 'boom' }, 'u1')).resolves.toEqual({ received: true });
    });

    it('falls back to a placeholder when message is missing or not a string', async () => {
      await service.recordClientError({ message: 42 } as never, 'u1');
      expect(prisma.auditLog.create.mock.calls[0][0].data.metadata.message).toBe('Unknown client error');
    });
  });

  describe('recentClientErrors', () => {
    it('maps audit rows to a flat shape and clamps the limit', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'a1',
          createdAt: new Date('2026-09-10T10:00:00Z'),
          actorId: 'u1',
          metadata: { message: 'boom', screen: '/x', platform: 'android', appVersion: '1.0.0', fatal: true, stack: 's' },
        },
      ]);

      const rows = await service.recentClientErrors(9999);
      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { action: 'CLIENT_ERROR' }, take: 200 }),
      );
      expect(rows[0]).toMatchObject({ id: 'a1', message: 'boom', screen: '/x', fatal: true, at: '2026-09-10T10:00:00.000Z' });
    });

    it('returns an empty list rather than throwing when the read fails', async () => {
      prisma.auditLog.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.recentClientErrors()).resolves.toEqual([]);
    });
  });
});
