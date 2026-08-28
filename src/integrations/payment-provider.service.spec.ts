import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PaymentProviderService } from './payment-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// The "Payment method" selector in the app used to be cosmetic - Paystack's hosted
// checkout shows every channel enabled on the account regardless of what's picked
// in-app, since no `channels` filter was ever sent. These tests pin down that the
// customer's selection now actually narrows what Paystack's checkout page offers.
describe('PaymentProviderService.initializeEscrow - Paystack channel selection', () => {
  let config: { get: jest.Mock };
  let prisma: {
    shipment: { findUnique: jest.Mock; update: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };
  let notifications: NotificationsService;
  let service: PaymentProviderService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) => {
        if (key === 'PAYMENT_PROVIDER') return 'paystack';
        if (key === 'PAYSTACK_SECRET_KEY') return 'sk_test_fake';
        return undefined;
      }),
    };
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue(undefined) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };
    notifications = {} as NotificationsService;
    service = new PaymentProviderService(config as unknown as ConfigService, prisma as unknown as PrismaService, notifications);

    fetchMock = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { authorization_url: 'https://paystack.test/checkout', reference: 'ref-1' } }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  function paystackRequestBody() {
    const [, requestInit] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(requestInit.body);
  }

  it('sends channels: ["card"] when the customer picks card', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN', method: 'card' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.paystack.co/transaction/initialize', expect.anything());
    expect(paystackRequestBody().channels).toEqual(['card']);
  });

  it('sends bank/ussd/bank_transfer channels when the customer picks bank_transfer', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN', method: 'bank_transfer' });

    expect(paystackRequestBody().channels).toEqual(['bank_transfer', 'bank', 'ussd']);
  });

  it('omits channels entirely when no method is specified, letting Paystack show everything enabled on the account', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN' });

    expect(paystackRequestBody().channels).toBeUndefined();
  });
});

// verifyPaystackSignature() used a plain `digest === signature` string comparison - this
// endpoint decides whether escrow gets marked funded, so that's a real timing side-channel
// on a financially load-bearing check, not just a style nit. Exercised indirectly through
// the public recordWebhook() method, since the signature check itself is private.
describe('PaymentProviderService webhook signature verification is constant-time and crash-safe', () => {
  const secretKey = 'sk_test_fake_webhook_secret';
  const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1', status: 'success' } });

  function buildService() {
    const config = {
      get: jest.fn((key: string) => (key === 'PAYSTACK_SECRET_KEY' ? secretKey : undefined)),
    } as unknown as ConfigService;
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    return new PaymentProviderService(config, prisma, {} as NotificationsService);
  }

  it('accepts a genuinely correct signature', async () => {
    const service = buildService();
    const realSignature = createHmac('sha512', secretKey).update(rawBody).digest('hex');

    const result = await service.recordWebhook('paystack', 'charge.success', JSON.parse(rawBody), realSignature, rawBody);

    expect(result.verified).toBe(true);
  });

  it('rejects a same-length but wrong signature', async () => {
    const service = buildService();
    const realSignature = createHmac('sha512', secretKey).update(rawBody).digest('hex');
    const tamperedSignature = `0${realSignature.slice(1)}` === realSignature ? `1${realSignature.slice(1)}` : `0${realSignature.slice(1)}`;

    const result = await service.recordWebhook('paystack', 'charge.success', JSON.parse(rawBody), tamperedSignature, rawBody);

    expect(result.verified).toBe(false);
  });

  it('rejects a shorter/malformed signature without throwing (timingSafeEqual would throw on a raw length mismatch)', async () => {
    const service = buildService();

    const result = await service.recordWebhook('paystack', 'charge.success', JSON.parse(rawBody), 'too-short', rawBody);

    expect(result.verified).toBe(false);
  });

  it('rejects a non-hex signature without throwing', async () => {
    const service = buildService();

    const result = await service.recordWebhook('paystack', 'charge.success', JSON.parse(rawBody), 'not-valid-hex-!!!-zzzz'.repeat(6), rawBody);

    expect(result.verified).toBe(false);
  });
});
