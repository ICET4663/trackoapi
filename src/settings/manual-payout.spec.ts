import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';
import type { AuthService } from '../auth/auth.service';

const noopAuthService = {} as unknown as AuthService;

// Paystack refuses transfers on a Starter business, so finance pays some withdrawals by bank
// transfer outside Trako and records the bank's reference. Recording must never send money,
// never double-record, and never apply to a payout that was not approved or is already paid.
describe('SettingsService records a payout paid by bank transfer', () => {
  type Payout = { id: string; driverId: string; amountKobo: number; status: string; driver?: { role: string } };
  type Transfer = { transferStatus: string | null; transferReference: string | null };

  function build(payout: Payout | null, transfer: Transfer = { transferStatus: null, transferReference: null }, options: { updateResult?: unknown; updateError?: Error } = {}) {
    const queryRawUnsafe = jest.fn((sql: string) => {
      if (sql.startsWith('select "transferStatus"')) return Promise.resolve([transfer]);
      if (sql.includes('update "Payout"')) {
        if (options.updateError) return Promise.reject(options.updateError);
        return Promise.resolve(options.updateResult ?? [{ id: payout?.id, driverId: payout?.driverId, amountKobo: payout?.amountKobo, status: 'PAID' }]);
      }
      return Promise.resolve([]);
    });
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const auditCreate = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn();
    const prisma = {
      payout: { findUnique: jest.fn().mockResolvedValue(payout), update },
      auditLog: { create: auditCreate },
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      notifications as unknown as NotificationsService,
      { get: jest.fn(() => undefined) } as unknown as ConfigService,
      noopAuthService,
    );
    return { service, queryRawUnsafe, notifications, auditCreate, update };
  }

  const approved: Payout = { id: 'payout-1', driverId: 'driver-1', amountKobo: 130_949_00, status: 'APPROVED', driver: { role: 'DRIVER' } };
  const bankTransfer = (reference = 'FT2611090001') => ({ decision: 'PAID', method: 'BANK_TRANSFER', reference });
  const updateCalls = (mock: jest.Mock) => mock.mock.calls.filter(([sql]) => String(sql).includes('update "Payout"'));
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('marks an approved payout paid with the bank reference, without calling Paystack', async () => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    const { service, queryRawUnsafe, notifications, auditCreate, update } = build(approved);

    const result = await service.reviewPayoutRequest('payout-1', 'admin-1', { decision: 'PAID', method: 'bank_transfer', reference: '  FT26110   90001 ' });

    expect(result).toEqual(expect.objectContaining({ status: 'PAID', message: expect.stringContaining('FT26110 90001') }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const [call] = updateCalls(queryRawUnsafe);
    expect(call[0]).toContain(`"transferStatus" = 'manual'`);
    expect(call[0]).toContain(`"status" = 'APPROVED'::"PayoutStatus"`);
    expect(call.slice(1)).toEqual(['payout-1', 'admin-1', 'Paid by bank transfer, reference FT26110 90001.', 'manual:FT26110 90001']);
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'PAYOUT_PAID_BY_BANK_TRANSFER', entityId: 'payout-1' }) });
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'driver-1', title: 'Withdrawal paid', body: expect.stringContaining('reference FT26110 90001'), actionUrl: '/driver/earnings',
    }));
  });

  it('records a payout whose Paystack transfer failed after it was marked paid', async () => {
    const { service, auditCreate } = build({ ...approved, status: 'PAID' }, { transferStatus: 'failed', transferReference: 'payout-payout-1-1' });

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer())).resolves.toEqual(expect.objectContaining({ status: 'PAID' }));
    expect(auditCreate.mock.calls[0][0].data.metadata).toEqual(expect.objectContaining({
      previousStatus: 'PAID', previousTransfer: { reference: 'payout-payout-1-1', status: 'failed' },
    }));
  });

  it.each<[string, Payout, Transfer, string]>([
    ['a pending payout', { ...approved, status: 'PENDING' }, { transferStatus: null, transferReference: null }, 'Approve this payout'],
    ['a rejected payout', { ...approved, status: 'REJECTED' }, { transferStatus: null, transferReference: null }, 'cannot be marked paid'],
    ['a payout Paystack already paid', { ...approved, status: 'PAID' }, { transferStatus: 'success', transferReference: 'payout-payout-1-1' }, 'already paid through Paystack'],
    ['a payout already recorded with another reference', { ...approved, status: 'PAID' }, { transferStatus: 'manual', transferReference: 'manual:OTHER-REF-1' }, 'already recorded as paid by bank transfer'],
  ])('refuses %s', async (_label, payout, transfer, message) => {
    const { service, queryRawUnsafe, notifications } = build(payout, transfer);

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer())).rejects.toThrow(message);
    expect(updateCalls(queryRawUnsafe)).toHaveLength(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('treats the same reference recorded twice as already done', async () => {
    const { service, notifications } = build({ ...approved, status: 'PAID' }, { transferStatus: 'manual', transferReference: 'manual:FT2611090001' });

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer()))
      .resolves.toEqual(expect.objectContaining({ message: 'This bank transfer is already recorded.' }));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it.each(['', 'abc', '<script>', 'x'.repeat(65)])('refuses the reference %p before touching the database', async (reference) => {
    const { service, queryRawUnsafe } = build(approved);

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer(reference))).rejects.toThrow('bank transfer reference');
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('only records a bank transfer when marking paid, and rejects unknown methods', async () => {
    const { service } = build(approved);

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', { ...bankTransfer(), decision: 'APPROVED' }))
      .rejects.toThrow('only be recorded when marking a payout paid');
    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', { ...bankTransfer(), method: 'CASH' }))
      .rejects.toThrow('PAYSTACK or BANK_TRANSFER');
  });

  it('says so when the payout changed in between (another admin or a webhook got there first)', async () => {
    const { service, notifications } = build(approved, undefined, { updateResult: [] });

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer())).rejects.toThrow('changed while you were recording it');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses a bank reference already used for another payout', async () => {
    const { service } = build(approved, undefined, { updateError: new Error('Unique constraint failed: Payout_transferReference_key') });

    await expect(service.reviewPayoutRequest('payout-1', 'admin-1', bankTransfer())).rejects.toThrow('already recorded against another payout');
  });

  it('adminPayoutRequests() shows how each payout was paid and flags a failed Paystack transfer', async () => {
    const row = (id: string, status: string) => ({
      id, driverId: 'driver-1', amountKobo: 100_00, status, bankLabel: 'GTBank **** 1234', note: null, reviewNote: null,
      createdAt: new Date('2026-11-06T10:00:00Z'), driver: { role: 'DRIVER', email: 'driver@tracko.ng', profile: { fullName: 'Demo Driver' } },
    });
    const prisma = {
      payout: { findMany: jest.fn().mockResolvedValue([row('p-manual', 'PAID'), row('p-failed', 'PAID'), row('p-approved', 'APPROVED')]) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { id: 'p-manual', transferStatus: 'manual', transferReference: 'manual:FT2611090001' },
        { id: 'p-failed', transferStatus: 'reversed', transferReference: 'payout-p-failed-1' },
      ]),
    } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);

    const [manual, failed, approvedRow] = await service.adminPayoutRequests();

    expect(manual).toEqual(expect.objectContaining({ paidBy: 'BANK_TRANSFER', transferReference: 'FT2611090001', transferFailed: false }));
    expect(failed).toEqual(expect.objectContaining({ paidBy: 'PAYSTACK', transferStatus: 'reversed', transferFailed: true }));
    expect(approvedRow).toEqual(expect.objectContaining({ paidBy: null, transferFailed: false }));
  });
});
