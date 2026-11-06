import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { fatalAlertConfig } from '../config/fatal-alert-config';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { paystackMode } from './paystack-mode';
import {
  type LedgerRow,
  parsePaystackMetadata,
  type PaystackRefund,
  type PaystackTransaction,
  reconcilePaystack,
  type ReconciliationResult,
  referencesToVerify,
} from './paystack-reconciliation';

const PAYSTACK = 'https://api.paystack.co';
const DAY = 24 * 60 * 60 * 1000;
export const RECONCILIATION_AUDIT_ACTION = 'PAYMENT_RECONCILIATION_RUN';
// Bounds that keep one run inside a serverless request: 20 pages of 100 per listing, 25
// one-by-one lookups for charges paid before the window, 8 s per Paystack call.
const MAX_PAGES = 20;
const MAX_VERIFY = 25;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_WINDOW_DAYS = 92;
const MAX_STORED_ITEMS = 100;

export type ReconciliationTrigger = 'manual' | 'schedule';

export type ReconciliationRun = {
  id: string;
  ranAt: string;
  trigger: ReconciliationTrigger;
  from: string;
  to: string;
  mode: 'test' | 'live' | null;
  status: 'ok' | 'problems' | 'not_configured' | 'failed';
  message: string;
  truncated: boolean;
  problems: ReconciliationResult['problems'];
  notes: ReconciliationResult['notes'];
  noteCounts: Record<string, number>;
  totals: ReconciliationResult['totals'] | null;
  counts: ReconciliationResult['counts'] | null;
};

class PaystackRequestError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
  }
}

// Weekly payment reconciliation: Paystack's successful payments and refunds against the escrow
// ledger. Read-only on both sides (GET requests and a SELECT); it never charges, refunds or
// transfers. Each run is kept in AuditLog so the admin Finance screen can show the latest one.
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async latest(): Promise<ReconciliationRun | null> {
    const row = await this.prisma.auditLog.findFirst({
      where: { action: RECONCILIATION_AUDIT_ACTION },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    return (row?.metadata as ReconciliationRun | null) ?? null;
  }

  // Monday's scheduled run covers the previous 7 days.
  async runScheduled(now = new Date()): Promise<ReconciliationRun | { skipped: string }> {
    if (now.getUTCDay() !== 1) return { skipped: 'Runs on Mondays.' };
    return this.run({ trigger: 'schedule', to: now, from: new Date(now.getTime() - 7 * DAY) });
  }

  async run(input: { trigger: ReconciliationTrigger; from?: Date; to?: Date; actorId?: string }): Promise<ReconciliationRun> {
    const to = input.to ?? new Date();
    const from = input.from ?? new Date(to.getTime() - 7 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('Choose a start date before the end date.');
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY) {
      throw new BadRequestException(`Reconcile at most ${MAX_WINDOW_DAYS} days at a time.`);
    }

    const base = {
      id: `recon_${randomUUID().replace(/-/g, '')}`,
      ranAt: new Date().toISOString(),
      trigger: input.trigger,
      from: from.toISOString(),
      to: to.toISOString(),
    };
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY')?.trim();
    let run: ReconciliationRun;
    if (!secretKey) {
      run = this.emptyRun(base, null, 'not_configured', 'Paystack is not configured on the API, so there is nothing to compare.');
    } else {
      const mode = paystackMode(secretKey);
      try {
        run = await this.compare(base, secretKey, mode, from, to);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Payment reconciliation failed: ${message}`);
        run = this.emptyRun(base, mode, 'failed', `The comparison did not finish: ${message}`);
      }
    }

    await this.prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: RECONCILIATION_AUDIT_ACTION,
        entity: 'PaymentReconciliation',
        entityId: run.id,
        metadata: JSON.parse(JSON.stringify(run)),
      },
    });
    if (run.status === 'problems' || (run.status === 'failed' && input.trigger === 'schedule')) {
      await this.alert(run);
    }
    return run;
  }

  private async compare(base: Omit<ReconciliationRun, 'mode' | 'status' | 'message' | 'truncated' | 'problems' | 'notes' | 'noteCounts' | 'totals' | 'counts'>, secretKey: string, mode: 'test' | 'live', from: Date, to: Date): Promise<ReconciliationRun> {
    const window = { from: from.toISOString(), to: to.toISOString() };
    const txList = await this.listAll<PaystackTransaction>(secretKey, '/transaction', { status: 'success', ...window });
    const refundList = await this.listAll<PaystackRefund>(secretKey, '/refund', window);
    const transactions = txList.rows;
    const refunds = refundList.rows;
    let truncated = txList.truncated || refundList.truncated;

    const shipmentIds = [...new Set(transactions.map((tx) => parsePaystackMetadata(tx.metadata).shipmentId).filter((id): id is string => typeof id === 'string'))];
    const ledger = await this.loadLedger(from, to, shipmentIds);

    // Charges Trako recorded whose payment fell outside the listing window: look each one up.
    const toVerify = referencesToVerify({ transactions, ledger });
    if (toVerify.length > MAX_VERIFY) truncated = true;
    for (const reference of toVerify.slice(0, MAX_VERIFY)) {
      try {
        const payload = await this.paystackGet<{ data?: PaystackTransaction }>(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
        if (payload.data) transactions.push(payload.data);
      } catch (error) {
        // Not found is reported as a missing payment; anything else stops the run.
        if (!(error instanceof PaystackRequestError) || (error.httpStatus !== 400 && error.httpStatus !== 404)) throw error;
      }
    }
    // Refunds of payments made before the window can predate it too.
    const paidTimes = transactions.map((tx) => new Date(tx.paid_at ?? tx.paidAt ?? to).getTime()).filter((t) => !Number.isNaN(t));
    const earliest = Math.min(from.getTime(), ...paidTimes);
    if (earliest < from.getTime()) {
      const known = new Set(refunds.map((r) => String(r.id)));
      const older = await this.listAll<PaystackRefund>(secretKey, '/refund', { from: new Date(earliest).toISOString(), to: window.from });
      truncated = truncated || older.truncated;
      for (const refund of older.rows) if (!known.has(String(refund.id))) refunds.push(refund);
    }

    const result = reconcilePaystack({ transactions, refunds, ledger });
    const noteCounts = result.notes.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }), {});
    const problemCount = result.problems.length;
    return {
      ...base,
      mode,
      status: problemCount ? 'problems' : 'ok',
      message: problemCount
        ? `${problemCount} difference${problemCount === 1 ? '' : 's'} between Paystack and the escrow ledger.`
        : 'Every Paystack payment and refund matches the escrow ledger.',
      truncated,
      problems: result.problems.slice(0, MAX_STORED_ITEMS),
      notes: result.notes.slice(0, MAX_STORED_ITEMS),
      noteCounts,
      totals: result.totals,
      counts: result.counts,
    };
  }

  private emptyRun(base: Pick<ReconciliationRun, 'id' | 'ranAt' | 'trigger' | 'from' | 'to'>, mode: ReconciliationRun['mode'], status: 'not_configured' | 'failed', message: string): ReconciliationRun {
    return { ...base, mode, status, message, truncated: false, problems: [], notes: [], noteCounts: {}, totals: null, counts: null };
  }

  private async loadLedger(from: Date, to: Date, shipmentIds: string[]): Promise<LedgerRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<LedgerRow[]>(
      `select e."shipmentId", s."reference" as "shipmentReference", e."status"::text as "escrowStatus",
              e."amount"::int as "escrowAmountKobo",
              coalesce(array_agg(substring(b."id" from 6)) filter (where b."id" is not null), '{}') as "chargeReferences"
         from "Escrow" e
         join "Shipment" s on s."id" = e."shipmentId"
         left join "BillingCharge" b on b."ref" = s."reference" and b."id" like 'bill-%'
        where (e."createdAt" between $1 and $2) or e."shipmentId" = any($3::text[])
        group by e."shipmentId", s."reference", e."status", e."amount"`,
      from,
      to,
      shipmentIds,
    );
    return rows.map((row) => ({ ...row, escrowAmountKobo: Number(row.escrowAmountKobo), chargeReferences: row.chargeReferences ?? [] }));
  }

  private async paystackGet<T>(secretKey: string, path: string): Promise<T & { status?: boolean; message?: string }> {
    const response = await fetch(`${PAYSTACK}${path}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => ({}))) as T & { status?: boolean; message?: string };
    if (!response.ok || payload.status === false) {
      throw new PaystackRequestError(`Paystack ${path.split('?')[0]} answered ${response.status}${payload.message ? ` (${payload.message})` : ''}.`, response.status);
    }
    return payload;
  }

  private async listAll<T>(secretKey: string, path: string, query: Record<string, string>): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ ...query, perPage: '100', page: String(page) });
      const payload = await this.paystackGet<{ data?: T[]; meta?: { pageCount?: number } }>(secretKey, `${path}?${params}`);
      const data = payload.data ?? [];
      rows.push(...data);
      const pageCount = Number(payload.meta?.pageCount ?? 1);
      if (page >= pageCount || !data.length) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }

  // Admins get an in-app notice (and push); the alert inbox gets an email when one is configured.
  private async alert(run: ReconciliationRun) {
    const title = run.status === 'failed' ? 'Payment reconciliation did not run' : 'Payment reconciliation found differences';
    const lines = run.problems.slice(0, 10).map((p) => `${p.shipmentReference ?? p.shipmentId ?? '-'}: ${p.detail}`);
    const body = run.status === 'failed' ? run.message : `${run.message} Open Finance to review them.`;
    await this.notifications
      .create({ role: 'ADMIN', title, body, tone: 'WARNING', entity: 'PaymentReconciliation', entityId: run.id, actionUrl: '/admin/finance' })
      .catch((error: unknown) => this.logger.warn(`Reconciliation notice not created: ${error instanceof Error ? error.message : String(error)}`));

    const email = fatalAlertConfig(this.config).email;
    if (!email) return;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${email.apiKey}` },
        body: JSON.stringify({
          from: email.from,
          to: [email.recipient],
          subject: `Trako: ${title.toLowerCase()}`,
          text: [
            `${run.message}`,
            `Window: ${run.from.slice(0, 10)} to ${run.to.slice(0, 10)} (Paystack ${run.mode ?? 'not configured'} mode).`,
            ...(lines.length ? ['', ...lines] : []),
            ...(run.problems.length > lines.length ? [`...and ${run.problems.length - lines.length} more.`] : []),
            '',
            'Full list: admin app, Finance, Payment reconciliation.',
          ].join('\n'),
        }),
        signal: AbortSignal.timeout(4_000),
      });
      if (!response.ok) this.logger.warn(`Reconciliation email failed (HTTP ${response.status}).`);
    } catch (error) {
      this.logger.warn(`Reconciliation email not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
