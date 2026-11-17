import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderService } from '../integrations/payment-provider.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/** How often the sweep runs when it is started by app traffic instead of a scheduler. */
export const DISPATCH_SWEEP_INTERVAL_MS = 5 * 60_000;
/** One server checks the shared "last run" mark at most this often, so busy polling costs no extra queries. */
const LOCAL_CHECK_INTERVAL_MS = 60_000;
/** Internal row; the admin settings screen lists only its own catalogue, so this never shows there. */
const LAST_RUN_KEY = 'dispatchSweepLastRunAt';

// The dispatch sweep: fund paid checkouts whose customer never returned, pass unanswered driver
// offers to the next driver, then offer waiting shipments. It is meant to run every 5 minutes.
//
// Vercel Hobby crons run once a day and GitHub's "every 5 minutes" schedule ran about every 5.5
// hours (measured 10 Nov 2026), so besides those schedulers the sweep is also started by app
// traffic: every signed-in app asks for its conversation list every few seconds while open.
// `runIfDue` lets one of those requests, across all servers, run the sweep once per 5 minutes.
// Two runs at once are safe (offer expiry and payment funding are conditional updates).
@Injectable()
export class DispatchSweepService {
  private readonly logger = new Logger(DispatchSweepService.name);
  private lastLocalCheckAt = 0;
  private running: Promise<unknown> | null = null;

  constructor(
    private readonly shipments: ShipmentsService,
    private readonly payments: PaymentProviderService,
    private readonly prisma: PrismaService,
  ) {}

  /** Runs the sweep now (the scheduled endpoint) and records the time, so traffic does not repeat it straight away. */
  async run() {
    // Fund before matching, so a shipment funded here is offered to drivers in this same run.
    const pendingPayments = await this.payments.confirmRecentPendingPayments()
      .catch((error: unknown) => ({ error: this.errorMessage(error) }));
    const assignments = await this.shipments.expireStaleAssignmentOffers();
    const matching = await this.shipments.matchWaitingShipments();
    await this.markRun(new Date()).catch(() => undefined);
    return { pendingPayments, assignments, matching, ranAt: new Date().toISOString() };
  }

  /**
   * Runs the sweep when nobody has in the last 5 minutes; otherwise does nothing. Never throws:
   * the request that triggers it (a conversation list) must not fail because of the sweep.
   */
  async runIfDue(now = Date.now()) {
    if (this.running) return false;
    if (now - this.lastLocalCheckAt < LOCAL_CHECK_INTERVAL_MS) return false;
    this.lastLocalCheckAt = now;
    try {
      if (!(await this.claim(now))) return false;
      this.running = this.run();
      await this.running;
      return true;
    } catch (error) {
      this.logger.warn(`Dispatch sweep from app traffic failed: ${this.errorMessage(error)}`);
      return false;
    } finally {
      this.running = null;
    }
  }

  // Atomic across servers: only the request that moves the mark forward runs the sweep.
  // ISO timestamps in UTC compare correctly as text.
  private async claim(now: number) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ key: string }>>(
      `insert into "PlatformSetting" ("key", "value", "updatedAt")
       values ($1, $2, current_timestamp)
       on conflict ("key") do update set "value" = excluded."value", "updatedAt" = current_timestamp
       where "PlatformSetting"."value" <= $3
       returning "key"`,
      LAST_RUN_KEY,
      new Date(now).toISOString(),
      new Date(now - DISPATCH_SWEEP_INTERVAL_MS).toISOString(),
    );
    return rows.length > 0;
  }

  private async markRun(at: Date) {
    await this.prisma.$executeRawUnsafe(
      `insert into "PlatformSetting" ("key", "value", "updatedAt")
       values ($1, $2, current_timestamp)
       on conflict ("key") do update set "value" = greatest("PlatformSetting"."value", excluded."value"), "updatedAt" = current_timestamp`,
      LAST_RUN_KEY,
      at.toISOString(),
    );
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
