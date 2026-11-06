// Trako's commission on a shipment. The customer pays the carrier's cost (fuel at today's
// pump price, running costs, base fare) plus this commission, all held in escrow. On
// release the driver (and a separate truck owner) share the carrier amount; the commission
// stays in Trako's Paystack balance.
//
// It is recorded on the Escrow row when the shipment is booked ("platformFeeKobo", added
// lazily like "paymentMode"), so changing the commission setting never alters a booked job.
// Escrows from before this change have no fee recorded and settle exactly as they did.

type RawExecutor = { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> };

// SQL for the part of a held payment that belongs to the driver and truck owner.
export function carrierAmountSql(escrowAlias = 'e') {
  return `(${escrowAlias}."amount" - coalesce(${escrowAlias}."platformFeeKobo", 0))`;
}

// SQL for Trako's commission on a held payment.
export function platformFeeSql(escrowAlias = 'e') {
  return `coalesce(${escrowAlias}."platformFeeKobo", 0)`;
}

const ensured = new WeakMap<object, Promise<void>>();

// Adds the column once per client; a failure is retried on the next call.
export function ensurePlatformFeeColumn(prisma: RawExecutor) {
  let pending = ensured.get(prisma);
  if (!pending) {
    // Inside then() so any failure, even a synchronous one, reaches the caller as a rejection.
    pending = Promise.resolve()
      .then(() => prisma.$executeRawUnsafe(`alter table "Escrow" add column if not exists "platformFeeKobo" integer`))
      .then(() => undefined);
    pending.catch(() => ensured.delete(prisma));
    ensured.set(prisma, pending);
  }
  return pending;
}

// Splits a carrier amount the same way the earnings ledger's SQL does (round() on a
// positive amount): the driver gets driverSharePercent when someone else owns the truck.
export function splitCarrierAmount(carrierKobo: number, separateOwner: boolean, driverSharePercent: number) {
  if (!separateOwner) return { driverKobo: carrierKobo, ownerKobo: 0 };
  const driverKobo = Math.round((carrierKobo * driverSharePercent) / 100);
  return { driverKobo, ownerKobo: Math.round((carrierKobo * (100 - driverSharePercent)) / 100) };
}
