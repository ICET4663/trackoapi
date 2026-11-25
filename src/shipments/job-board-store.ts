import { PrismaService } from '../prisma/prisma.service';
import { JOB_BOARD_PRICE_RANGE_KEY, priceRangePercentFrom } from './job-board-price';

// Job board (owner rule, 23 November 2026): a paid, approved load is first shown to every
// eligible driver who is not on an undelivered trip. Drivers ask for it; the customer picks
// one of them, and only then is the load locked to that driver. If nobody asks within the
// board time, automatic dispatch offers it to the nearest driver as before.
//
// Requests live in their own table, created here on first use like the other newer columns,
// so the live database needs no manual migration and the AssignmentStatus enum is untouched.

/** Default minutes a load stays on the board before automatic dispatch may offer it. */
export const DEFAULT_JOB_BOARD_MINUTES = 10;
/** Setting row that overrides it (0 turns the board's head start off; at most 120). */
export const JOB_BOARD_MINUTES_KEY = 'jobBoardMinutes';
/**
 * While a driver's request is waiting for the customer, automatic dispatch holds off, for
 * at most this long after the request; then the load is offered as usual so it never stalls
 * on a customer who does not answer. Operations can choose for the customer at any time.
 */
export const CUSTOMER_CHOICE_MINUTES = 60;

export type JobRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN' | 'CLOSED';

export type JobRequestRow = {
  id: string;
  shipmentId: string;
  driverId: string;
  vehicleId: string | null;
  status: JobRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  /** Where the driver's phone was when they asked (24 Nov 2026); null on older requests. */
  requestLatitude?: number | null;
  requestLongitude?: number | null;
  /**
   * The driver's own price (25 Nov 2026), unpaid loads only: their trip pay, and what the customer
   * would pay for it with Trako's commission. Null when the driver asked at the quoted price.
   */
  proposedCarrierKobo?: number | null;
  proposedPriceKobo?: number | null;
  proposedCommissionKobo?: number | null;
  /** Set when the customer accepted the price: the load is then held for this driver. */
  priceAcceptedAt?: Date | null;
  /** The shipment's money before the price was accepted, so it can be put back. */
  quoteBeforeKobo?: number | null;
  feeBeforeKobo?: number | null;
  driverPayBeforeKobo?: number | null;
};

/** Every JobRequest column the service reads. */
export const JOB_REQUEST_COLUMNS = `"id", "shipmentId", "driverId", "vehicleId", "status", "createdAt", "decidedAt",
  "requestLatitude", "requestLongitude", "proposedCarrierKobo", "proposedPriceKobo", "proposedCommissionKobo",
  "priceAcceptedAt", "quoteBeforeKobo", "feeBeforeKobo", "driverPayBeforeKobo"`;

let tableReady: Promise<void> | null = null;

export function ensureJobRequestTable(prisma: PrismaService) {
  tableReady ??= (async () => {
    await prisma.$executeRawUnsafe(
      `create table if not exists "JobRequest" (
         "id" text primary key,
         "shipmentId" text not null references "Shipment"("id") on delete cascade,
         "driverId" text not null references "User"("id") on delete cascade,
         "vehicleId" text,
         "status" text not null default 'PENDING',
         "createdAt" timestamp(3) not null default current_timestamp,
         "decidedAt" timestamp(3)
       )`,
    );
    await prisma.$executeRawUnsafe(
      `create unique index if not exists "JobRequest_shipment_driver" on "JobRequest"("shipmentId", "driverId")`,
    );
    await prisma.$executeRawUnsafe(
      `create index if not exists "JobRequest_driver_status" on "JobRequest"("driverId", "status")`,
    );
    await prisma.$executeRawUnsafe(
      `alter table "JobRequest" add column if not exists "requestLatitude" double precision,
         add column if not exists "requestLongitude" double precision`,
    );
    await prisma.$executeRawUnsafe(
      `alter table "JobRequest" add column if not exists "proposedCarrierKobo" integer,
         add column if not exists "proposedPriceKobo" integer,
         add column if not exists "proposedCommissionKobo" integer,
         add column if not exists "priceAcceptedAt" timestamp(3),
         add column if not exists "quoteBeforeKobo" integer,
         add column if not exists "feeBeforeKobo" integer,
         add column if not exists "driverPayBeforeKobo" integer`,
    );
  })().catch((error: unknown) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

/** Test hook: forget that the table was created. */
export function resetJobRequestTableForTests() {
  tableReady = null;
}

export async function jobBoardMinutes(prisma: PrismaService) {
  let setting: { value: unknown } | null = null;
  try {
    setting = await prisma.platformSetting.findUnique({ where: { key: JOB_BOARD_MINUTES_KEY } });
  } catch {
    setting = null;
  }
  const value = Number(setting?.value ?? DEFAULT_JOB_BOARD_MINUTES);
  return Number.isFinite(value) && value >= 0 && value <= 120 ? Math.round(value) : DEFAULT_JOB_BOARD_MINUTES;
}

export async function jobBoardPriceRangePercent(prisma: PrismaService) {
  let setting: { value: unknown } | null = null;
  try {
    setting = await prisma.platformSetting.findUnique({ where: { key: JOB_BOARD_PRICE_RANGE_KEY } });
  } catch {
    setting = null;
  }
  return priceRangePercentFrom(setting?.value);
}

/** Of these shipments, the ones with a driver's request the customer has not answered yet. */
export async function shipmentsAwaitingCustomerChoice(prisma: PrismaService, shipmentIds: string[], now = Date.now()) {
  if (!shipmentIds.length) return new Set<string>();
  await ensureJobRequestTable(prisma);
  const rows = await prisma.$queryRawUnsafe<Array<{ shipmentId: string }>>(
    `select distinct "shipmentId" from "JobRequest"
     where "status" = 'PENDING' and "shipmentId" = any($1::text[]) and "createdAt" > $2`,
    shipmentIds,
    new Date(now - CUSTOMER_CHOICE_MINUTES * 60_000),
  );
  return new Set(rows.map((row) => row.shipmentId));
}
