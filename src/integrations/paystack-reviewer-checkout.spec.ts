import type { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { PaymentProviderService } from './payment-provider.service';

// Apple and Google reviewers must be able to book and pay without real money. Once a live
// key is configured, their payments go through PAYSTACK_TEST_SECRET_KEY, and test money
// can only ever fund a reviewer's own shipment.
const LIVE_KEY = 'sk_live_main';
const TEST_KEY = 'sk_test_review';
const REVIEWER = 'apple.review.customer@trako.com.ng';
const CUSTOMER = 'customer@tracko.ng';

function buildService({ mainKey = LIVE_KEY, testKey = TEST_KEY as string | undefined, customerEmail = REVIEWER } = {}) {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'PAYMENT_PROVIDER') return 'paystack';
      if (key === 'PAYSTACK_SECRET_KEY') return mainKey;
      if (key === 'PAYSTACK_TEST_SECRET_KEY') return testKey;
      return undefined;
    }),
  } as unknown as ConfigService;
  const queryRawUnsafe = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('select e."amount", e."currency"')) {
      return Promise.resolve([{ amount: 500000, currency: 'NGN', status: 'PENDING', shipmentStatus: 'PENDING_PAYMENT' }]);
    }
    if (sql.includes(`set "status" = 'FUNDED'`)) return Promise.resolve([{ shipmentId: 'ship-1' }]);
    return Promise.resolve([]);
  });
  const prisma = {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    shipment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'ship-1', customerId: 'cust-1', quotedPriceKobo: 500000, reference: 'TRK-1', customer: { email: customerEmail },
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    paymentMethod: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
  } as unknown as PrismaService;
  const notifications = { create: jest.fn().mockResolvedValue({ id: 'n-1' }) } as unknown as NotificationsService;
  return { service: new PaymentProviderService(config, prisma, notifications), queryRawUnsafe };
}

function chargeWebhook(reference: string, key: string) {
  const rawBody = JSON.stringify({
    event: 'charge.success',
    data: { status: 'success', reference, amount: 500000, currency: 'NGN', metadata: { shipmentId: 'ship-1' } },
  });
  return { body: JSON.parse(rawBody), rawBody, signature: createHmac('sha512', key).update(rawBody).digest('hex') };
}

const fundingSql = (queryRawUnsafe: jest.Mock) =>
  queryRawUnsafe.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes(`set "status" = 'FUNDED'`));

describe('Store reviewers pay in Paystack test mode once live keys are on', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: 'r' } }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });
  afterEach(() => { global.fetch = originalFetch; });

  const initializeCall = () => {
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    return { authorization: init.headers.Authorization, reference: JSON.parse(init.body).reference as string };
  };

  it('opens a reviewer\'s checkout with the test key and a review reference', async () => {
    const { service } = buildService();

    await service.initializeEscrow({ shipmentId: 'ship-1' });

    expect(initializeCall().authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(initializeCall().reference).toMatch(/^tracko_review_\d+$/);
  });

  it('keeps a real customer on the live key', async () => {
    const { service } = buildService({ customerEmail: CUSTOMER });

    await service.initializeEscrow({ shipmentId: 'ship-1' });

    expect(initializeCall().authorization).toBe(`Bearer ${LIVE_KEY}`);
    expect(initializeCall().reference).toMatch(/^tracko_escrow_\d+$/);
  });

  it('refuses a reviewer\'s checkout in live mode when no test key is set, instead of charging real money', async () => {
    const { service } = buildService({ testKey: '' });

    await expect(service.initializeEscrow({ shipmentId: 'ship-1' })).rejects.toThrow(/Review checkout is not set up/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.status().reviewerTestCheckout).toBe(false);
  });

  it('ignores a live key given as the test key', () => {
    expect(buildService({ testKey: 'sk_live_other' }).service.status().reviewerTestCheckout).toBe(false);
    expect(buildService().service.status().reviewerTestCheckout).toBe(true);
  });

  it('changes nothing in test mode: reviewers use the main test key', async () => {
    const { service } = buildService({ mainKey: 'sk_test_main', testKey: '' });

    await service.initializeEscrow({ shipmentId: 'ship-1' });

    expect(initializeCall().authorization).toBe('Bearer sk_test_main');
    expect(service.status().reviewerTestCheckout).toBe(true);
  });

  it('funds a reviewer\'s escrow from a test-signed webhook without stamping it live', async () => {
    const { service, queryRawUnsafe } = buildService();
    const { body, rawBody, signature } = chargeWebhook('tracko_review_1', TEST_KEY);

    const result = await service.recordWebhook('paystack', 'charge.success', body, signature, rawBody);

    expect(result).toMatchObject({ verified: true, escrowUpdated: true });
    expect(fundingSql(queryRawUnsafe)).toBeDefined();
    expect(fundingSql(queryRawUnsafe)).not.toContain('paymentMode');
  });

  it('never lets test money fund a real customer\'s shipment', async () => {
    const { service, queryRawUnsafe } = buildService({ customerEmail: CUSTOMER });
    const { body, rawBody, signature } = chargeWebhook('tracko_review_1', TEST_KEY);

    const result = await service.recordWebhook('paystack', 'charge.success', body, signature, rawBody);

    expect(result.escrowUpdated).toBe(false);
    expect(fundingSql(queryRawUnsafe)).toBeUndefined();
  });

  it('does not accept the test key\'s signature on a normal live payment', async () => {
    const { service } = buildService({ customerEmail: CUSTOMER });
    const { body, rawBody, signature } = chargeWebhook('tracko_escrow_1', TEST_KEY);

    const result = await service.recordWebhook('paystack', 'charge.success', body, signature, rawBody);

    expect(result).toMatchObject({ verified: false, escrowUpdated: false });
  });

  it('stamps a real customer\'s live payment live', async () => {
    const { service, queryRawUnsafe } = buildService({ customerEmail: CUSTOMER });
    const { body, rawBody, signature } = chargeWebhook('tracko_escrow_1', LIVE_KEY);

    await service.recordWebhook('paystack', 'charge.success', body, signature, rawBody);

    expect(fundingSql(queryRawUnsafe)).toContain(`"paymentMode" = 'live'`);
  });

  it('verifies a review reference with the test key', async () => {
    const { service } = buildService();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'success', reference: 'tracko_review_1', amount: 500000, currency: 'NGN', metadata: { shipmentId: 'ship-1' } },
      }),
    });

    const result = await service.verifyPaystackPayment('tracko_review_1', { sub: 'cust-1', role: 'CUSTOMER' });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(result).toMatchObject({ verified: true, escrowUpdated: true });
  });
});
