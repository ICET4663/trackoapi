import { ConfigService } from '@nestjs/config';
import { PaymentProviderService } from './payment-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// A customer who paid but never came back to Trako (closed the tab, was signed out, or paid
// in another browser) left the escrow PENDING unless Paystack's webhook arrived (6 Nov
// end-to-end run). The dispatch sweep now asks Paystack about recent unpaid checkouts.
describe('PaymentProviderService.confirmRecentPendingPayments', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function paystackSays(byReference: Record<string, { status: string; shipmentId?: string; amount?: number }>) {
    const fetchMock = jest.fn(async (url: string) => {
      const reference = decodeURIComponent(url.split('/').pop() ?? '');
      const tx = byReference[reference];
      return {
        ok: true,
        json: async () => ({
          status: true,
          message: 'Verification successful',
          data: tx && {
            status: tx.status,
            reference,
            amount: tx.amount ?? 500000,
            currency: 'NGN',
            metadata: { shipmentId: tx.shipmentId ?? 'ship-1' },
          },
        }),
      };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    return fetchMock;
  }

  function buildService(pendingRows: Array<{ shipmentId: string; reference: string | null }>, { secretKey = 'sk_test_fake' } = {}) {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'PAYMENT_PROVIDER') return 'paystack';
        if (key === 'PAYSTACK_SECRET_KEY') return secretKey;
        return undefined;
      }),
    } as unknown as ConfigService;
    const queryRawUnsafe = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes(`'PAYSTACK_ESCROW_INITIALIZED'`)) return Promise.resolve(pendingRows);
      if (sql.includes('select e."amount", e."currency"')) {
        return Promise.resolve([{ amount: 500000, currency: 'NGN', status: 'PENDING', shipmentStatus: 'PENDING_PAYMENT' }]);
      }
      if (sql.includes(`set "status" = 'FUNDED'`)) return Promise.resolve([{ shipmentId: 'ship-1' }]);
      return Promise.resolve([]);
    });
    const auditCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      auditLog: { create: auditCreate },
      shipment: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ship-1', customerId: 'cust-1', reference: 'TRK-1', status: 'PENDING_PAYMENT' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentMethod: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
    } as unknown as PrismaService;
    const notificationCreate = jest.fn().mockResolvedValue({ id: 'n-1' });
    const notifications = { create: notificationCreate } as unknown as NotificationsService;
    return { service: new PaymentProviderService(config, prisma, notifications), queryRawUnsafe, auditCreate, notificationCreate };
  }

  it('funds escrow for a checkout Paystack reports paid, and says so in the audit log', async () => {
    paystackSays({ tracko_escrow_1: { status: 'success' } });
    const { service, queryRawUnsafe, auditCreate, notificationCreate } = buildService([{ shipmentId: 'ship-1', reference: 'tracko_escrow_1' }]);

    const result = await service.confirmRecentPendingPayments();

    expect(result).toEqual({ checked: 1, funded: ['ship-1'], failed: 0 });
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining(`set "status" = 'FUNDED'`), 'ship-1');
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'PAYSTACK_PAYMENT_CONFIRMED_BY_SWEEP', entityId: 'ship-1' }) });
    // The usual "Escrow funded" alerts go out, exactly as when the webhook funds it.
    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'cust-1', title: 'Escrow funded' }));
  });

  it('stays silent about a checkout that is still open: no funding, no "not completed" alert, no audit noise', async () => {
    paystackSays({ tracko_escrow_1: { status: 'abandoned' } });
    const { service, queryRawUnsafe, auditCreate, notificationCreate } = buildService([{ shipmentId: 'ship-1', reference: 'tracko_escrow_1' }]);

    const result = await service.confirmRecentPendingPayments();

    expect(result).toEqual({ checked: 1, funded: [], failed: 0 });
    expect(queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining(`set "status" = 'FUNDED'`), expect.anything());
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('does not fund a shipment from a payment Paystack ties to another shipment', async () => {
    paystackSays({ tracko_escrow_1: { status: 'success', shipmentId: 'someone-else' } });
    const { service, queryRawUnsafe } = buildService([{ shipmentId: 'ship-1', reference: 'tracko_escrow_1' }]);

    const result = await service.confirmRecentPendingPayments();

    expect(result.funded).toEqual([]);
    expect(queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining(`set "status" = 'FUNDED'`), expect.anything());
  });

  it('does not fund escrow when Paystack collected a different amount', async () => {
    paystackSays({ tracko_escrow_1: { status: 'success', amount: 100 } });
    const { service, queryRawUnsafe } = buildService([{ shipmentId: 'ship-1', reference: 'tracko_escrow_1' }]);

    const result = await service.confirmRecentPendingPayments();

    expect(result.funded).toEqual([]);
    expect(queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining(`set "status" = 'FUNDED'`), expect.anything());
  });

  it('checks every recent attempt of a shipment until one is paid, then stops for that shipment', async () => {
    const fetchMock = paystackSays({
      tracko_escrow_3: { status: 'abandoned' },
      tracko_escrow_2: { status: 'success' },
      tracko_escrow_1: { status: 'success' },
    });
    const { service } = buildService([
      { shipmentId: 'ship-1', reference: 'tracko_escrow_3' },
      { shipmentId: 'ship-1', reference: 'tracko_escrow_2' },
      { shipmentId: 'ship-1', reference: 'tracko_escrow_1' },
      { shipmentId: 'ship-1', reference: null },
    ]);

    const result = await service.confirmRecentPendingPayments();

    expect(result).toEqual({ checked: 2, funded: ['ship-1'], failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps going when Paystack cannot be reached for one reference', async () => {
    const fetchMock = paystackSays({ tracko_escrow_2: { status: 'success', shipmentId: 'ship-2' } });
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const { service } = buildService([
      { shipmentId: 'ship-1', reference: 'tracko_escrow_1' },
      { shipmentId: 'ship-2', reference: 'tracko_escrow_2' },
    ]);

    const result = await service.confirmRecentPendingPayments();

    expect(result.checked).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.funded).toEqual(['ship-2']);
  });

  it('only looks at the last day of checkouts by default and caps how many it checks', async () => {
    paystackSays({});
    const { service, queryRawUnsafe } = buildService([]);
    const now = new Date('2026-11-10T12:00:00Z');

    await service.confirmRecentPendingPayments({ now });

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`e."status" = 'PENDING'::"EscrowStatus"`),
      new Date('2026-11-09T12:00:00Z'),
      20,
    );
  });

  it('does nothing without Paystack keys (mock payments)', async () => {
    const fetchMock = paystackSays({});
    const { service, queryRawUnsafe } = buildService([], { secretKey: '' });

    const result = await service.confirmRecentPendingPayments();

    expect(result).toEqual({ skipped: 'Paystack checkout is not configured.' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
