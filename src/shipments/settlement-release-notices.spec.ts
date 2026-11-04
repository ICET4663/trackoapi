import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// Release notices must quote what the earnings ledger credits: with a separate truck owner
// the driver gets `driverOwnerSharePercent` (default 70) and the owner the rest.
describe('ShipmentsService escrow release notices', () => {
  function build(assignment: { driverId: string; reference: string; ownerId: string | null } | null, sharePercent?: string) {
    const create = jest.fn().mockResolvedValue({ id: 'n' });
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue(assignment ? [assignment] : []),
      platformSetting: { findUnique: jest.fn().mockResolvedValue(sharePercent === undefined ? null : { value: sharePercent }) },
    } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, { create } as unknown as NotificationsService, {} as MapsProviderService);
    const notify = (amount: number) =>
      (service as unknown as { notifySettlementOfEscrowRelease: (id: string, a: number) => Promise<void> })
        .notifySettlementOfEscrowRelease('shp-1', amount);
    return { create, notify };
  }

  it('splits the notice between driver and a separate truck owner (default 70/30)', async () => {
    const { create, notify } = build({ driverId: 'drv-1', reference: 'TRK-1', ownerId: 'own-1' });

    await notify(10_000_000); // N100,000

    expect(create).toHaveBeenCalledTimes(2);
    const [driver, owner] = create.mock.calls.map(([input]) => input);
    expect(driver).toMatchObject({ userId: 'drv-1', vars: { amount: 'N70,000', reference: 'TRK-1' }, actionUrl: '/driver/earnings' });
    expect(driver.body).toContain('N70,000');
    expect(owner).toMatchObject({
      userId: 'own-1',
      role: 'TRUCK_OWNER',
      title: 'Payment released',
      templateKey: 'notifyTpl.ownerEscrowReleased',
      vars: { amount: 'N30,000', reference: 'TRK-1' },
      actionUrl: '/owner/settlement/shp-1',
      preferenceKey: 'escrowPayments',
    });
  });

  it('uses the configured share setting', async () => {
    const { create, notify } = build({ driverId: 'drv-1', reference: 'TRK-1', ownerId: 'own-1' }, '60');

    await notify(10_000_000);

    expect(create.mock.calls.map(([input]) => input.vars.amount)).toEqual(['N60,000', 'N40,000']);
  });

  it('gives the whole amount to a driver who owns the truck, with no owner notice', async () => {
    const { create, notify } = build({ driverId: 'drv-1', reference: 'TRK-1', ownerId: 'drv-1' });

    await notify(10_000_000);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].vars.amount).toBe('N100,000');
  });

  it('gives the whole amount when the trip has no truck on record', async () => {
    const { create, notify } = build({ driverId: 'drv-1', reference: 'TRK-1', ownerId: null });

    await notify(10_000_000);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].vars.amount).toBe('N100,000');
  });

  it('sends no owner notice when the driver share is 100%', async () => {
    const { create, notify } = build({ driverId: 'drv-1', reference: 'TRK-1', ownerId: 'own-1' }, '100');

    await notify(10_000_000);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].vars.amount).toBe('N100,000');
  });

  it('sends nothing without an accepted driver and never throws', async () => {
    const { create, notify } = build(null);
    await expect(notify(10_000_000)).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });
});
