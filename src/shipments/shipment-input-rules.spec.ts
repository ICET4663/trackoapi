import { BadRequestException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// 27 Nov input rules on the shipment side: TRK references retry on a same-millisecond clash,
// and driver counter-offers must be a whole, storable amount with a bounded note.

function build(prisma: Record<string, unknown> = {}) {
  return new ShipmentsService(prisma as unknown as PrismaService, {} as NotificationsService, {} as MapsProviderService);
}

const clash = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['reference'] } });

describe('TRK reference clash', () => {
  type Retry = { createWithFreshReference: <T>(create: (reference: string) => Promise<T>) => Promise<T> };

  it('retries with the next number when two bookings land in the same millisecond', async () => {
    const service = build() as unknown as Retry;
    const seen: string[] = [];
    const create = jest.fn(async (reference: string) => {
      seen.push(reference);
      if (seen.length === 1) throw clash();
      return { reference };
    });

    const result = await service.createWithFreshReference(create);

    expect(create).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatch(/^TRK-\d{13}$/);
    expect(result.reference).toMatch(/^TRK-\d{13}$/);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('does not retry other failures, and gives up after a few clashes', async () => {
    const service = build() as unknown as Retry;
    const outage = jest.fn().mockRejectedValue(new Error('connection reset'));
    await expect(service.createWithFreshReference(outage)).rejects.toThrow('connection reset');
    expect(outage).toHaveBeenCalledTimes(1);

    const always = jest.fn().mockRejectedValue(clash());
    await expect(service.createWithFreshReference(always)).rejects.toMatchObject({ code: 'P2002' });
    expect(always).toHaveBeenCalledTimes(4);
  });
});

describe('driver counter-offer input', () => {
  it('refuses a missing, fractional-below-one, or unstorable amount before reading the offer', async () => {
    const findUnique = jest.fn();
    const service = build({ driverAssignment: { findUnique } });

    for (const amount of [undefined, 'abc', 0, 0.4, -100]) {
      await expect(service.proposeCounterOffer('a-1', 'd-1', amount, undefined)).rejects.toThrow('Enter a valid proposed amount.');
    }
    await expect(service.proposeCounterOffer('a-1', 'd-1', 3_000_000_000, undefined)).rejects.toThrow('That proposed amount is too large.');
    await expect(service.proposeCounterOffer('a-1', 'd-1', 50_000_00, 'x'.repeat(501))).rejects.toBeInstanceOf(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
