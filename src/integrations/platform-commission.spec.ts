import type { MapsProviderService } from './maps-provider.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { carrierAmountSql, ensurePlatformFeeColumn, platformFeeSql, splitCarrierAmount } from './platform-commission';

describe('platform commission helpers', () => {
  it('the carrier amount is the held payment minus the recorded commission (none on older escrows)', () => {
    expect(carrierAmountSql()).toBe('(e."amount" - coalesce(e."platformFeeKobo", 0))');
    expect(platformFeeSql('x')).toBe('coalesce(x."platformFeeKobo", 0)');
  });

  it('splits the carrier amount like the earnings ledger', () => {
    expect(splitCarrierAmount(10_000_000, true, 70)).toEqual({ driverKobo: 7_000_000, ownerKobo: 3_000_000 });
    expect(splitCarrierAmount(10_000_000, false, 70)).toEqual({ driverKobo: 10_000_000, ownerKobo: 0 });
  });

  it('gives a hired driver the recorded pay and the owner the rest, never more than the whole', () => {
    expect(splitCarrierAmount(20_916_900, true, 70, 2_704_000)).toEqual({ driverKobo: 2_704_000, ownerKobo: 18_212_900 });
    expect(splitCarrierAmount(1_000_000, true, 70, 5_000_000)).toEqual({ driverKobo: 1_000_000, ownerKobo: 0 });
    expect(splitCarrierAmount(20_916_900, false, 70, 2_704_000)).toEqual({ driverKobo: 20_916_900, ownerKobo: 0 });
  });

  it('adds the column once per database client and retries after a failure', async () => {
    const execute = jest.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(0);
    const prisma = { $executeRawUnsafe: execute };

    await expect(ensurePlatformFeeColumn(prisma)).rejects.toThrow('busy');
    await ensurePlatformFeeColumn(prisma);
    await ensurePlatformFeeColumn(prisma);

    expect(execute.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('add column if not exists "platformFeeKobo" integer'),
      expect.stringContaining('add column if not exists "driverPayKobo" integer'),
    ]));
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('reports a missing database method as a rejection, not a crash', async () => {
    await expect(ensurePlatformFeeColumn({} as never)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('ShipmentsService records the commission when a shipment is booked', () => {
  function build() {
    const execute = jest.fn().mockResolvedValue(0);
    const service = new ShipmentsService(
      { $executeRawUnsafe: execute } as unknown as PrismaService,
      {} as NotificationsService,
      {} as MapsProviderService,
    );
    const record = (quote: { quotedPriceKobo: number; pricingBreakdown?: Record<string, string | number> }) =>
      (service as unknown as { recordPlatformCommission: (id: string, q: typeof quote) => Promise<void> }).recordPlatformCommission('shp-1', quote);
    return { execute, record };
  }

  it('stores the quoted commission on the escrow', async () => {
    const { execute, record } = build();

    await record({ quotedPriceKobo: 23_008_600, pricingBreakdown: { commissionKobo: 2_091_700, hiredDriverPayKobo: 2_704_000 } });

    expect(execute).toHaveBeenLastCalledWith('update "Escrow" set "platformFeeKobo" = $2, "driverPayKobo" = $3 where "shipmentId" = $1', 'shp-1', 2_091_700, 2_704_000);
  });

  it('records no driver pay when the quote has none or an impossible one', async () => {
    const { execute, record } = build();

    await record({ quotedPriceKobo: 23_008_600, pricingBreakdown: { commissionKobo: 2_091_700 } });
    expect(execute).toHaveBeenLastCalledWith(expect.any(String), 'shp-1', 2_091_700, null);
    await record({ quotedPriceKobo: 23_008_600, pricingBreakdown: { commissionKobo: 2_091_700, hiredDriverPayKobo: 99_000_000 } });
    expect(execute).toHaveBeenLastCalledWith(expect.any(String), 'shp-1', 2_091_700, null);
  });

  it('stores nothing for a quote signed before commissions, or an impossible commission', async () => {
    const { execute, record } = build();

    await record({ quotedPriceKobo: 13_094_900, pricingBreakdown: { escrowFeeKobo: 442_800 } });
    await record({ quotedPriceKobo: 1_000_000, pricingBreakdown: { commissionKobo: 1_000_000 } });
    await record({ quotedPriceKobo: 1_000_000, pricingBreakdown: { commissionKobo: -5 } });

    expect(execute).not.toHaveBeenCalled();
  });
});
