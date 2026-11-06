import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { PaymentReconciliationService, RECONCILIATION_AUDIT_ACTION } from './payment-reconciliation.service';

type Json = Record<string, unknown>;
const tx = (over: Json = {}) => ({
  id: 101,
  reference: 'tracko_escrow_1',
  status: 'success',
  amount: 500000,
  paid_at: '2026-11-03T10:00:00.000Z',
  metadata: { shipmentId: 'shp1', purpose: 'shipment_escrow' },
  ...over,
});
const ledgerRow = (over: Json = {}) => ({
  shipmentId: 'shp1',
  shipmentReference: 'TRK-1',
  escrowStatus: 'FUNDED',
  escrowAmountKobo: 500000,
  chargeReferences: ['tracko_escrow_1'],
  ...over,
});

function setup(options: { env?: Json; ledger?: Json[]; paystack?: (url: URL) => { status?: number; body: Json } } = {}) {
  const env: Json = { PAYSTACK_SECRET_KEY: 'sk_test_x', ...options.env };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    auditLog: { create: auditCreate, findFirst: jest.fn() },
    $queryRawUnsafe: jest.fn().mockResolvedValue(options.ledger ?? [ledgerRow()]),
  } as unknown as PrismaService;
  const notify = jest.fn().mockResolvedValue({});
  const notifications = { create: notify } as unknown as NotificationsService;

  const requests: Array<{ url: string; method: string; auth?: string; body?: string }> = [];
  const paystack: (url: URL) => { status?: number; body: Json } = options.paystack ?? ((url: URL) => ({
    body: url.pathname === '/transaction' && url.searchParams.get('status') === 'success' ? { status: true, data: [tx()], meta: { pageCount: 1 } } : { status: true, data: [], meta: { pageCount: 1 } },
  }));
  const fetchMock = jest.fn(async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push({ url: input, method: init.method ?? 'GET', auth: init.headers?.Authorization, body: init.body });
    const url = new URL(input);
    if (url.hostname === 'api.resend.com') return { ok: true, status: 200, json: async () => ({}) };
    const { status = 200, body } = paystack(url);
    return { ok: status < 400, status, json: async () => body };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  return { service: new PaymentReconciliationService(config, prisma, notifications), auditCreate, notify, requests, prisma };
}

const window = { from: new Date('2026-10-30T00:00:00Z'), to: new Date('2026-11-06T00:00:00Z') };

describe('PaymentReconciliationService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('matching records: stores an "ok" run, alerts nobody, and only reads from Paystack', async () => {
    const { service, auditCreate, notify, requests } = setup();

    const run = await service.run({ trigger: 'manual', actorId: 'admin1', ...window });

    expect(run.status).toBe('ok');
    expect(run.mode).toBe('test');
    expect(run.totals).toMatchObject({ paystackCollectedKobo: 500000, ledgerFundedKobo: 500000 });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: RECONCILIATION_AUDIT_ACTION, actorId: 'admin1', entityId: run.id }) });
    expect(notify).not.toHaveBeenCalled();
    const paystackCalls = requests.filter((r) => r.url.startsWith('https://api.paystack.co'));
    expect(paystackCalls.map((r) => new URL(r.url).pathname)).toEqual(['/transaction', '/transaction', '/refund']);
    expect(paystackCalls.every((r) => r.method === 'GET' && r.auth === 'Bearer sk_test_x')).toBe(true);
    // refunded payments are "reversed" on Paystack and must be read as well
    expect(paystackCalls.slice(0, 2).map((r) => new URL(r.url).searchParams.get('status'))).toEqual(['success', 'reversed']);
  });

  it('differences: notifies admins and emails the alert inbox', async () => {
    const { service, notify, requests } = setup({
      env: { TELEMETRY_ALERT_EMAIL: 'ops@example.com', EMAIL_FROM: 'Trako <no-reply@trako.com.ng>', RESEND_API_KEY: 're_x' },
      paystack: (url) => ({ body: { status: true, data: url.pathname === '/transaction' && url.searchParams.get('status') === 'success' ? [tx({ amount: 400000 })] : [], meta: { pageCount: 1 } } }),
    });

    const run = await service.run({ trigger: 'schedule', ...window });

    expect(run.status).toBe('problems');
    expect(run.problems.map((p) => p.type)).toEqual(['amount_mismatch']);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN', tone: 'WARNING', actionUrl: '/admin/finance', entityId: run.id }));
    const email = requests.find((r) => r.url === 'https://api.resend.com/emails');
    expect(email?.body).toContain('TRK-1');
    expect(email?.body).toContain('ops@example.com');
  });

  it('looks up a recorded charge that was paid before the window', async () => {
    const { service, requests } = setup({
      paystack: (url) => {
        if (url.pathname === '/transaction/verify/tracko_escrow_1') return { body: { status: true, data: tx({ paid_at: '2026-10-20T10:00:00.000Z' }) } };
        return { body: { status: true, data: [], meta: { pageCount: 1 } } };
      },
    });

    const run = await service.run({ trigger: 'manual', ...window });

    expect(run.status).toBe('ok');
    const paths = requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/transaction/verify/tracko_escrow_1');
    // and the refunds of that older payment are listed too
    expect(paths.filter((p) => p === '/refund')).toHaveLength(2);
  });

  it('reports a charge Paystack does not know as missing', async () => {
    const { service } = setup({
      paystack: (url) => (url.pathname.startsWith('/transaction/verify')
        ? { status: 400, body: { status: false, message: 'Transaction reference not found' } }
        : { body: { status: true, data: [], meta: { pageCount: 1 } } }),
    });

    const run = await service.run({ trigger: 'manual', ...window });

    expect(run.problems.map((p) => p.type)).toEqual(['paystack_payment_missing']);
  });

  it('a Paystack outage is stored as failed; only the scheduled run alerts', async () => {
    const down = () => ({ status: 503, body: { status: false, message: 'Service unavailable' } });
    const manual = setup({ paystack: down });
    const manualRun = await manual.service.run({ trigger: 'manual', ...window });
    expect(manualRun.status).toBe('failed');
    expect(manualRun.message).toContain('503');
    expect(manual.auditCreate).toHaveBeenCalled();
    expect(manual.notify).not.toHaveBeenCalled();

    const scheduled = setup({ paystack: down });
    await scheduled.service.run({ trigger: 'schedule', ...window });
    expect(scheduled.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payment reconciliation did not run' }));
  });

  it('without a Paystack key it records "not configured" and calls nobody', async () => {
    const { service, requests, notify } = setup({ env: { PAYSTACK_SECRET_KEY: '' } });

    const run = await service.run({ trigger: 'schedule', ...window });

    expect(run.status).toBe('not_configured');
    expect(requests).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses reversed or overlong windows before calling Paystack', async () => {
    const { service, requests } = setup();
    await expect(service.run({ trigger: 'manual', from: window.to, to: window.from })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.run({ trigger: 'manual', from: new Date('2026-01-01'), to: window.to })).rejects.toBeInstanceOf(BadRequestException);
    expect(requests).toHaveLength(0);
  });

  it('the schedule runs on Mondays only, over the previous 7 days', async () => {
    const { service, requests } = setup();
    await expect(service.runScheduled(new Date('2026-11-06T03:00:00Z'))).resolves.toEqual({ skipped: 'Runs on Mondays.' });
    expect(requests).toHaveLength(0);

    const run = await service.runScheduled(new Date('2026-11-09T03:00:00Z'));
    expect(run).toMatchObject({ trigger: 'schedule', from: '2026-11-02T03:00:00.000Z', to: '2026-11-09T03:00:00.000Z' });
  });

  it('latest() returns the newest stored run', async () => {
    const { service, prisma } = setup();
    (prisma.auditLog.findFirst as jest.Mock).mockResolvedValue({ metadata: { id: 'recon_1', status: 'ok' } });

    await expect(service.latest()).resolves.toEqual({ id: 'recon_1', status: 'ok' });
    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { action: RECONCILIATION_AUDIT_ACTION }, orderBy: { createdAt: 'desc' } }));
  });
});
