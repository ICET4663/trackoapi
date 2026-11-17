import type { PaymentProviderService } from '../integrations/payment-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DispatchSweepService } from './dispatch-sweep.service';
import type { ShipmentsService } from './shipments.service';

function build(claimRows: Array<{ key: string }> | Error = [{ key: 'dispatchSweepLastRunAt' }]) {
  const calls: string[] = [];
  const shipments = {
    expireStaleAssignmentOffers: jest.fn(async () => { calls.push('expire'); return { expiredCount: 0, validityMinutes: 15 }; }),
    matchWaitingShipments: jest.fn(async () => { calls.push('match'); return { waiting: 0, offered: 0 }; }),
  } as unknown as ShipmentsService;
  const payments = {
    confirmRecentPendingPayments: jest.fn(async () => { calls.push('payments'); return { checked: 0, funded: [], failed: 0 }; }),
  } as unknown as PaymentProviderService;
  const $queryRawUnsafe = claimRows instanceof Error ? jest.fn().mockRejectedValue(claimRows) : jest.fn().mockResolvedValue(claimRows);
  const $executeRawUnsafe = jest.fn().mockResolvedValue(1);
  const prisma = { $queryRawUnsafe, $executeRawUnsafe } as unknown as PrismaService;
  return { service: new DispatchSweepService(shipments, payments, prisma), calls, $queryRawUnsafe, $executeRawUnsafe };
}

describe('DispatchSweepService', () => {
  const NOW = Date.parse('2026-11-17T12:00:00.000Z');

  it('runs the sweep in order (payments, expiry, matching) and records the run time', async () => {
    const { service, calls, $executeRawUnsafe } = build();

    const result = await service.run();

    expect(calls).toEqual(['payments', 'expire', 'match']);
    expect(result).toMatchObject({ assignments: { expiredCount: 0 }, matching: { waiting: 0 } });
    expect($executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('greatest('), 'dispatchSweepLastRunAt', expect.any(String));
  });

  it('a failed payment check never stops expiry and matching', async () => {
    const { service, calls } = build();
    (service as unknown as { payments: { confirmRecentPendingPayments: jest.Mock } }).payments.confirmRecentPendingPayments
      .mockRejectedValueOnce(new Error('paystack down'));

    const result = await service.run();

    expect(calls).toEqual(['expire', 'match']);
    expect(result.pendingPayments).toEqual({ error: 'paystack down' });
  });

  it('runs from app traffic when it claims the 5-minute slot', async () => {
    const { service, calls, $queryRawUnsafe } = build();

    await expect(service.runIfDue(NOW)).resolves.toBe(true);

    expect(calls).toEqual(['payments', 'expire', 'match']);
    // Claims only when the last run is at least 5 minutes old.
    expect($queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('where "PlatformSetting"."value" <= $3'),
      'dispatchSweepLastRunAt',
      '2026-11-17T12:00:00.000Z',
      '2026-11-17T11:55:00.000Z',
    );
  });

  it('does nothing when another server already ran it in the last 5 minutes', async () => {
    const { service, calls } = build([]);

    await expect(service.runIfDue(NOW)).resolves.toBe(false);

    expect(calls).toEqual([]);
  });

  it('asks the database at most once a minute per server, however often the inbox is polled', async () => {
    const { service, $queryRawUnsafe } = build([]);

    await service.runIfDue(NOW);
    await service.runIfDue(NOW + 2_500);
    await service.runIfDue(NOW + 59_000);
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);

    await service.runIfDue(NOW + 60_000);
    expect($queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('never throws, so the inbox request that triggered it still answers', async () => {
    const { service, calls } = build(new Error('connection reset'));

    await expect(service.runIfDue(NOW)).resolves.toBe(false);
    expect(calls).toEqual([]);

    const failingSweep = build();
    (failingSweep.service as unknown as { shipments: { matchWaitingShipments: jest.Mock } }).shipments.matchWaitingShipments
      .mockRejectedValueOnce(new Error('db busy'));
    await expect(failingSweep.service.runIfDue(NOW)).resolves.toBe(false);
  });

  it('does not start a second run on the same server while one is still going', async () => {
    const { service, $queryRawUnsafe } = build();
    let finishExpiry: () => void = () => undefined;
    (service as unknown as { shipments: { expireStaleAssignmentOffers: jest.Mock } }).shipments.expireStaleAssignmentOffers
      .mockImplementationOnce(() => new Promise((resolve) => { finishExpiry = () => resolve({ expiredCount: 0 }); }));

    const first = service.runIfDue(NOW);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.runIfDue(NOW + 120_000)).resolves.toBe(false);
    finishExpiry();
    await expect(first).resolves.toBe(true);
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});
