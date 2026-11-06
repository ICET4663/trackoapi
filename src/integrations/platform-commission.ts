// Trako's commission on a shipment. The customer pays the carrier's cost (fuel at today's
// pump price, running costs, base fare) plus this commission, all held in escrow. On
// release the driver (and a separate truck owner) share the carrier amount; the commission
// stays in Trako's Paystack balance.
//
// It is recorded on the Escrow row when the shipment is booked ("platformFeeKobo", added
// lazily like "paymentMode"), so changing the commission setting never alters a booked job.
// Escrows from before this change have no fee recorded and settle exactly as they did.
//
// Who gets the carrier amount depends on whose truck it is:
// - a driver on their own truck gets all of it (fuel, truck costs and their pay);
// - a hired driver on someone else's truck gets the hired-driver pay quoted at booking
//   ("driverPayKobo"), and the truck owner, who fuels and maintains the truck, gets the rest.
// Escrows booked before driver pay was recorded keep the old percentage split.

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
      .then(() => prisma.$executeRawUnsafe(`alter table "Escrow" add column if not exists "driverPayKobo" integer`))
      .then(() => undefined);
    pending.catch(() => ensured.delete(prisma));
    ensured.set(prisma, pending);
  }
  return pending;
}

// Splits a carrier amount the same way the earnings ledger's SQL does: a driver on their own
// truck gets it all; a hired driver gets the recorded pay (capped at the carrier amount) and the
// owner the rest; without recorded pay, the old driverSharePercent split with SQL round().
export function splitCarrierAmount(carrierKobo: number, separateOwner: boolean, driverSharePercent: number, driverPayKobo?: number | null) {
  if (!separateOwner) return { driverKobo: carrierKobo, ownerKobo: 0 };
  if (driverPayKobo != null && Number.isFinite(Number(driverPayKobo))) {
    const driverKobo = Math.min(carrierKobo, Math.max(0, Math.round(Number(driverPayKobo))));
    return { driverKobo, ownerKobo: carrierKobo - driverKobo };
  }
  const driverKobo = Math.round((carrierKobo * driverSharePercent) / 100);
  return { driverKobo, ownerKobo: Math.round((carrierKobo * (100 - driverSharePercent)) / 100) };
}
