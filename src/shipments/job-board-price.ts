// Driver price proposals on the job board (owner rule, 25 November 2026).
//
// - Only on loads the customer has not paid for yet. Once money is held, drivers ask at the paid
//   price, so a paid load is never topped up or part-refunded because of the board.
// - The driver proposes their own trip pay (the carrier amount). The customer price is that plus
//   Trako's commission at the same rate as the signed quote, so the platform keeps its share.
// - The trip pay can never go below what the trip costs to run (base fare, fuel, operating cost
//   and tolls from the quote), and stays within the admin range (default 30%) of the quoted pay.

/** Setting: how far (in %) a driver's proposed trip pay may move from the quote. 0 turns proposals off. */
export const JOB_BOARD_PRICE_RANGE_KEY = 'jobBoardPriceRangePercent';
export const DEFAULT_JOB_BOARD_PRICE_RANGE_PERCENT = 30;
export const MAX_JOB_BOARD_PRICE_RANGE_PERCENT = 100;
/**
 * A checkout opened this recently may still be paid at the old amount, and a payment that does
 * not match the escrow is never marked funded. So a new price waits until it is this old.
 */
export const RECENT_CHECKOUT_MINUTES = 15;

export type QuoteParts = {
  /** What the customer pays now. */
  totalKobo: number;
  /** The trip pay in the quote (customer price minus commission). */
  carrierKobo: number;
  commissionKobo: number;
  commissionRate: number;
  /** Base fare, fuel, operating cost and tolls: the floor for any proposal. */
  runningCostKobo: number;
  hiredDriverPayKobo: number | null;
};

export type ProposalBounds = { minCarrierKobo: number; maxCarrierKobo: number };

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const ceilNaira = (kobo: number) => Math.ceil(kobo / 100) * 100;
const floorNaira = (kobo: number) => Math.floor(kobo / 100) * 100;

/**
 * Reads the commission and running cost from a signed quote's breakdown. Returns null for a
 * quote without them (signed before 6 November), which then cannot take a proposal.
 */
export function quotePartsFrom(totalKobo: number | null | undefined, breakdown: unknown): QuoteParts | null {
  if (!totalKobo || totalKobo <= 0 || !breakdown || typeof breakdown !== 'object') return null;
  const parts = breakdown as Record<string, unknown>;
  const commissionKobo = toNumber(parts.commissionKobo);
  const carrierCostKobo = toNumber(parts.carrierCostKobo);
  if (commissionKobo === null || commissionKobo < 0 || carrierCostKobo === null || carrierCostKobo <= 0) return null;
  const carrierKobo = carrierCostKobo;
  const rate = toNumber(parts.commissionRate);
  const commissionRate = rate !== null && rate >= 0 && rate < 1 ? rate : commissionKobo / carrierKobo;

  const pieces = ['baseFareKobo', 'fuelCostKobo', 'operatingCostKobo', 'tollAllowanceKobo'].map((key) => toNumber(parts[key]));
  const runningFromPieces = pieces.every((piece) => piece !== null) ? pieces.reduce<number>((sum, piece) => sum + (piece ?? 0), 0) : null;
  const runningFallback = carrierKobo - (toNumber(parts.minimumFareAdjustmentKobo) ?? 0) - (toNumber(parts.demandSurgeKobo) ?? 0);
  const runningCostKobo = Math.max(0, Math.min(carrierKobo, runningFromPieces ?? runningFallback));
  const driverPay = toNumber(parts.hiredDriverPayKobo);

  return {
    totalKobo,
    carrierKobo,
    commissionKobo,
    commissionRate,
    runningCostKobo,
    hiredDriverPayKobo: driverPay !== null && driverPay > 0 ? driverPay : null,
  };
}

/** The trip pay a driver may propose, or null when proposals are off for this range. */
export function proposalBounds(parts: QuoteParts, rangePercent: number): ProposalBounds | null {
  if (!(rangePercent > 0)) return null;
  const share = Math.min(MAX_JOB_BOARD_PRICE_RANGE_PERCENT, rangePercent) / 100;
  const minCarrierKobo = ceilNaira(Math.max(parts.runningCostKobo, parts.carrierKobo * (1 - share)));
  const maxCarrierKobo = floorNaira(parts.carrierKobo * (1 + share));
  return minCarrierKobo <= maxCarrierKobo ? { minCarrierKobo, maxCarrierKobo } : null;
}

/** What the customer pays for a proposed trip pay: the pay plus commission at the quote's rate. */
export function priceForCarrier(parts: QuoteParts, carrierKobo: number) {
  const carrier = Math.round(carrierKobo / 100) * 100;
  const commissionKobo = Math.round((carrier / 100) * parts.commissionRate) * 100;
  return { carrierKobo: carrier, commissionKobo, totalKobo: carrier + commissionKobo };
}

/** Reads the range setting; anything unusable falls back to the default. */
export function priceRangePercentFrom(value: unknown) {
  if (value === undefined || value === null || value === '') return DEFAULT_JOB_BOARD_PRICE_RANGE_PERCENT;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= MAX_JOB_BOARD_PRICE_RANGE_PERCENT
    ? Math.round(number)
    : DEFAULT_JOB_BOARD_PRICE_RANGE_PERCENT;
}
