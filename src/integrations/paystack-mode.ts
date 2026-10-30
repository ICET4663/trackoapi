import type { PrismaService } from '../prisma/prisma.service';

export type PaystackMode = 'live' | 'test';

// Paystack keeps test and live money completely apart, but Trako's escrow, payout and
// bank-recipient rows used to share one table with nothing saying which side they came
// from. Rows written while a live key is configured are stamped 'live'; anything
// unstamped predates the live switch and was test money. In test mode nothing is
// stamped or filtered, so behaviour before the switch is unchanged.
export function paystackMode(secretKey?: string | null): PaystackMode {
  return secretKey?.startsWith('sk_live_') ? 'live' : 'test';
}

const ensured = new WeakMap<PrismaService, Promise<void>>();

// Runs the column additions once per client; a failure is retried on the next call.
export function ensurePaymentModeColumns(prisma: PrismaService) {
  let pending = ensured.get(prisma);
  if (!pending) {
    pending = (async () => {
      await prisma.$executeRawUnsafe(`alter table "Escrow" add column if not exists "paymentMode" text`);
      await prisma.$executeRawUnsafe(`alter table "Payout" add column if not exists "paymentMode" text`);
      await prisma.$executeRawUnsafe(`alter table "BankAccount" add column if not exists "recipientCode" text`);
      await prisma.$executeRawUnsafe(`alter table "BankAccount" add column if not exists "recipientMode" text`);
    })();
    pending.catch(() => ensured.delete(prisma));
    ensured.set(prisma, pending);
  }
  return pending;
}
