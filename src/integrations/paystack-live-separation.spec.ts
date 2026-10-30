import type { ConfigService } from '@nestjs/config';
import type { AuthService } from '../auth/auth.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { PaymentProviderService } from './payment-provider.service';
import { paystackMode } from './paystack-mode';

// Demo shipments were paid and released with test money. Once a live key is configured,
// none of that may count toward a real payout balance, be paid out, or reuse a
// test-mode bank recipient.
const configWith = (secretKey: string) =>
  ({ get: jest.fn((key: string) => (key === 'PAYSTACK_SECRET_KEY' ? secretKey : key === 'PAYMENT_PROVIDER' ? 'paystack' : undefined)) }) as unknown as ConfigService;

function settingsService(secretKey: string, prisma: Record<string, unknown>) {
  return new SettingsService(
    { $executeRawUnsafe: jest.fn().mockResolvedValue(0), ...prisma } as unknown as PrismaService,
    { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
    configWith(secretKey),
    {} as AuthService,
  );
}

const released = { shipmentId: 'shp-1', reference: 'TRK-1', route: 'Lagos to Abuja', amount: 2_000_000, currency: 'NGN', status: 'RELEASED', updatedAt: new Date() };

function earningsPrisma(livePayoutIds: string[]) {
  const queryRawUnsafe = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes(`e."status" = 'RELEASED'`)) return Promise.resolve([released]);
    if (sql.includes('select "id" from "Payout"')) return Promise.resolve(livePayoutIds.map((id) => ({ id })));
    return Promise.resolve([]);
  });
  const payouts = [
    { id: 'test-payout', driverId: 'driver-1', amountKobo: 1_500_000, status: 'PAID', bankLabel: null, createdAt: new Date() },
    { id: 'live-payout', driverId: 'driver-1', amountKobo: 500_000, status: 'PENDING', bankLabel: null, createdAt: new Date() },
  ];
  return {
    queryRawUnsafe,
    prisma: {
      $queryRawUnsafe: queryRawUnsafe,
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      payout: { findMany: jest.fn().mockResolvedValue(payouts) },
    },
  };
}

describe('Paystack live mode keeps test money out of payouts', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('reads the mode from the secret key prefix', () => {
    expect(paystackMode('sk_live_abc')).toBe('live');
    expect(paystackMode('sk_test_abc')).toBe('test');
    expect(paystackMode(undefined)).toBe('test');
  });

  it('counts only live-stamped escrow and payouts toward the balance', async () => {
    const { prisma, queryRawUnsafe } = earningsPrisma(['live-payout']);
    const result = await settingsService('sk_live_abc', prisma).driverEarnings('driver-1', { strict: true });

    const escrowSql = queryRawUnsafe.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes('join "Escrow"'));
    expect(escrowSql).toHaveLength(2);
    escrowSql.forEach((sql) => expect(sql).toContain(`e."paymentMode" = 'live'`));
    // The test-mode payout is ignored; only the live one is subtracted.
    expect(result.availableBalance).toBe(2_000_000 - 500_000);
  });

  it('leaves test mode exactly as before', async () => {
    const { prisma, queryRawUnsafe } = earningsPrisma([]);
    const result = await settingsService('sk_test_abc', prisma).driverEarnings('driver-1', { strict: true });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('paymentMode'))).toBe(false);
    expect(result.availableBalance).toBe(0);
  });

  it('refuses to send a real transfer for a payout requested with test money', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    const update = jest.fn();
    const service = settingsService('sk_live_abc', {
      payout: { findUnique: jest.fn().mockResolvedValue({ id: 'payout-1', driverId: 'driver-1', amountKobo: 500_000, status: 'APPROVED' }), update },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ paymentMode: null }]),
    });

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', { decision: 'PAID' })).rejects.toThrow('test-mode earnings');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('treats a bank account saved in test mode as unverified once live', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{ id: 'bank-1', verified: false }]);
    await settingsService('sk_live_abc', { $queryRawUnsafe: queryRawUnsafe }).bankAccount('driver-1');

    expect(String(queryRawUnsafe.mock.calls[0][0])).toContain(`"recipientMode" = 'live'`);
  });

  it.each([['sk_live_abc', true], ['sk_test_abc', false]])('stamps escrow funded with %s as live: %s', async (key, stamped) => {
    const queryRawUnsafe = jest.fn()
      .mockResolvedValueOnce([{ amount: 500_000, currency: 'NGN', status: 'PENDING', shipmentStatus: 'ESCROW_FUNDED' }])
      .mockResolvedValueOnce([]);
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, data: { status: 'success', reference: 'ref-1', amount: 500_000, currency: 'NGN', metadata: { shipmentId: 'shp-1' } } }),
    });
    const prisma = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: jest.fn().mockResolvedValue(0), auditLog: { create: jest.fn().mockResolvedValue(undefined) } };
    const service = new PaymentProviderService(configWith(key), prisma as unknown as PrismaService, {} as NotificationsService);

    await service.verifyPaystackPayment('ref-1', { sub: 'admin-1', role: 'ADMIN' });

    const claimSql = String(queryRawUnsafe.mock.calls[1][0]);
    expect(claimSql).toContain(`set "status" = 'FUNDED'`);
    expect(claimSql.includes(`"paymentMode" = 'live'`)).toBe(stamped);
  });
});
