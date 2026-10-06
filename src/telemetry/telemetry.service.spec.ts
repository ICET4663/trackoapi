import type { RateLimitService } from '../auth/rate-limit.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { TelemetryService } from './telemetry.service';

describe('TelemetryService', () => {
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock } };
  let rateLimit: { assertAllowed: jest.Mock };
  let config: { get: jest.Mock };
  let service: TelemetryService;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) } };
    rateLimit = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn().mockReturnValue(undefined) };
    service = new TelemetryService(
      prisma as unknown as PrismaService,
      rateLimit as unknown as RateLimitService,
      config as unknown as ConfigService,
    );
  });

  describe('recordClientError', () => {
    afterEach(() => jest.restoreAllMocks());

    it('sends a compact Resend email without stacks or actor identifiers', async () => {
      const values: Record<string, string> = { TELEMETRY_ALERT_EMAIL: 'ops@example.test', EMAIL_FROM: 'Trako <alerts@updates.trako.com.ng>', RESEND_API_KEY: 're_test' };
      config.get.mockImplementation((key: string) => values[key]);
      const network = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
      await service.recordClientError({ fatal: true, message: 'Crash', stack: 'sensitive-stack' }, 'user-secret');
      const body = JSON.parse(network.mock.calls[0][1]!.body as string);
      expect(body.to).toEqual(['ops@example.test']);
      expect(body.text).not.toContain('sensitive-stack');
      expect(body.text).not.toContain('user-secret');
      expect(network).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({ method: 'POST' }));
    });

    it('still sends email when the configured webhook fails', async () => {
      const values: Record<string, string> = { TELEMETRY_ALERT_WEBHOOK_URL: 'https://alerts.example.test', TELEMETRY_ALERT_EMAIL: 'ops@example.test', EMAIL_FROM: 'alerts@updates.trako.com.ng', RESEND_API_KEY: 're_test' };
      config.get.mockImplementation((key: string) => values[key]);
      const network = jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true } as Response);
      await expect(service.recordClientError({ fatal: true, message: 'Crash' })).resolves.toEqual({ received: true });
      expect(network).toHaveBeenCalledTimes(2);
    });

    it('does not send alerts after duplicate-alert rate limiting rejects', async () => {
      config.get.mockImplementation((key: string) => key === 'TELEMETRY_ALERT_WEBHOOK_URL' ? 'https://alerts.example.test' : undefined);
      rateLimit.assertAllowed.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('duplicate'));
      const network = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
      await expect(service.recordClientError({ fatal: true, message: 'Crash' })).resolves.toEqual({ received: true });
      expect(network).not.toHaveBeenCalled();
    });
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

    it('sends one compact webhook alert for a fatal client error when configured', async () => {
      config.get.mockReturnValue('https://alerts.example.test/tracko');
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

      await service.recordClientError({ message: 'App crashed', screen: '/driver/trip', platform: 'ios', fatal: true }, 'driver-1');

      expect(rateLimit.assertAllowed).toHaveBeenCalledWith('client-error-alert:app-crashed', expect.objectContaining({ limit: 1 }));
      expect(fetchMock).toHaveBeenCalledWith(new URL('https://alerts.example.test/tracko'), expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('TRAKO_FATAL_CLIENT_ERROR'),
      }));
      fetchMock.mockRestore();
    });

    it('never sends telemetry alerts to a non-HTTPS webhook', async () => {
      config.get.mockReturnValue('http://alerts.example.test/tracko');
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
      await service.recordClientError({ message: 'App crashed', fatal: true }, 'driver-1');
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockRestore();
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

    it('audits admin access to the client-error log', async () => {
      await service.recentClientErrors(20, 'admin-1');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ actorId: 'admin-1', action: 'CLIENT_ERROR_LOG_VIEWED', entity: 'Telemetry' }),
      }));
    });
  });
});
