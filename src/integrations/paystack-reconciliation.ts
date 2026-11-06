// Compares Trako's escrow ledger with Paystack's own records (launch gap: "weekly compare of the
// Paystack dashboard against the admin escrow ledger" before live mode). Pure functions only:
// PaymentReconciliationService and scripts/reconcile-paystack.js fetch both sides.
//
// Problems are differences someone in finance has to act on. Notes are expected differences that
// are listed so the totals can be explained (demo or mock funding, store-review payments).

export const PAYSTACK_ESCROW_PREFIX = 'tracko_escrow_';
export const PAYSTACK_REVIEW_PREFIX = 'tracko_review_';
// Paystack marks a fully refunded (or charged-back) payment "reversed"; the money still arrived first.
const PAID_STATUSES = new Set(['success', 'reversed']);
// Escrow states that mean the customer's money arrived at some point.
export const FUNDED_ESCROW_STATES = new Set(['FUNDED', 'HELD', 'RELEASE_READY', 'RELEASED', 'DISPUTED', 'REFUNDED']);

export type PaystackTransaction = {
  id?: number | string | null;
  reference?: string | null;
  status?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  paid_at?: string | null;
  paidAt?: string | null;
  metadata?: unknown;
};

export type PaystackRefund = {
  id?: number | string | null;
  transaction?: number | string | { id?: number | string | null; reference?: string | null } | null;
  transaction_reference?: string | null;
  amount?: number | string | null;
  status?: string | null;
};

export type LedgerRow = {
  shipmentId: string;
  shipmentReference: string;
  escrowStatus: string;
  escrowAmountKobo: number;
  chargeReferences: string[];
};

export type ReconciliationProblemType =
  | 'paid_unknown_shipment'
  | 'duplicate_payment'
  | 'paid_not_funded'
  | 'amount_mismatch'
  | 'paystack_payment_missing'
  | 'refund_not_sent'
  | 'refund_partial'
  | 'refund_not_in_ledger'
  | 'payment_reversed';
export type ReconciliationNoteType = 'store_review_payment' | 'funded_outside_paystack';

export type ReconciliationItem<T extends string> = {
  type: T;
  shipmentId: string | null;
  shipmentReference: string | null;
  detail: string;
};

export type ReconciliationResult = {
  problems: ReconciliationItem<ReconciliationProblemType>[];
  notes: ReconciliationItem<ReconciliationNoteType>[];
  totals: { paystackCollectedKobo: number; paystackRefundedKobo: number; ledgerFundedKobo: number; ledgerRefundedKobo: number };
  counts: { paystackPayments: number; paystackRefunds: number; ledgerRows: number };
};

type NormalizedTransaction = {
  id: string | null;
  reference: string;
  status: string;
  amountKobo: number;
  paidAt: string | null;
  shipmentId: string | null;
  purpose: string | null;
};

export function parsePaystackMetadata(metadata: unknown): { shipmentId?: string; purpose?: string } {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as { shipmentId?: string; purpose?: string }) : {};
    } catch {
      return {};
    }
  }
  return typeof metadata === 'object' ? (metadata as { shipmentId?: string; purpose?: string }) : {};
}

function normalizeTransaction(tx: PaystackTransaction): NormalizedTransaction {
  const metadata = parsePaystackMetadata(tx.metadata);
  return {
    id: tx.id == null ? null : String(tx.id),
    reference: String(tx.reference ?? ''),
    status: String(tx.status ?? ''),
    amountKobo: Number(tx.amount ?? 0),
    paidAt: tx.paid_at ?? tx.paidAt ?? null,
    shipmentId: typeof metadata.shipmentId === 'string' ? metadata.shipmentId : null,
    purpose: typeof metadata.purpose === 'string' ? metadata.purpose : null,
  };
}

function normalizeRefund(refund: PaystackRefund) {
  const tx = refund.transaction;
  const txObject = tx && typeof tx === 'object' ? tx : null;
  return {
    transactionId: txObject ? String(txObject.id ?? '') : tx == null ? null : String(tx),
    transactionReference: txObject?.reference ?? refund.transaction_reference ?? null,
    amountKobo: Number(refund.amount ?? 0),
    status: String(refund.status ?? ''),
  };
}

const isTrakoEscrowPayment = (tx: NormalizedTransaction) =>
  tx.purpose === 'shipment_escrow' || tx.reference.startsWith(PAYSTACK_ESCROW_PREFIX) || tx.reference.startsWith(PAYSTACK_REVIEW_PREFIX);

// A Paystack refund counts once it is not failed; "pending"/"processing" means money is on its way back.
const refundCounts = (refund: { status: string }) => !/failed|reversed/i.test(refund.status);

export function reconcilePaystack(input: { transactions?: PaystackTransaction[]; refunds?: PaystackRefund[]; ledger?: LedgerRow[] }): ReconciliationResult {
  const { transactions = [], refunds = [], ledger = [] } = input;
  const problems: ReconciliationResult['problems'] = [];
  const notes: ReconciliationResult['notes'] = [];
  const item = <T extends string>(type: T, row: Partial<LedgerRow> | null, detail: string): ReconciliationItem<T> => ({
    type,
    shipmentId: row?.shipmentId ?? null,
    shipmentReference: row?.shipmentReference ?? null,
    detail,
  });

  const successes = transactions.map(normalizeTransaction).filter((tx) => PAID_STATUSES.has(tx.status) && isTrakoEscrowPayment(tx));
  const countedRefunds = refunds.map(normalizeRefund).filter(refundCounts);

  const ledgerById = new Map(ledger.map((row) => [row.shipmentId, row]));
  const ledgerByChargeRef = new Map<string, LedgerRow>();
  for (const row of ledger) for (const ref of row.chargeReferences ?? []) ledgerByChargeRef.set(ref, row);

  // Group Paystack payments by shipment (metadata first, then the charge reference Trako recorded).
  const paymentsByShipment = new Map<string, NormalizedTransaction[]>();
  for (const tx of successes) {
    const row = (tx.shipmentId ? ledgerById.get(tx.shipmentId) : undefined) ?? ledgerByChargeRef.get(tx.reference);
    if (!row) {
      if (tx.reference.startsWith(PAYSTACK_REVIEW_PREFIX)) continue;
      problems.push(item('paid_unknown_shipment', { shipmentId: tx.shipmentId ?? undefined }, `Paystack ${tx.reference} received ${tx.amountKobo} kobo for a shipment Trako does not have.`));
      continue;
    }
    const list = paymentsByShipment.get(row.shipmentId) ?? [];
    list.push(tx);
    paymentsByShipment.set(row.shipmentId, list);
  }

  const refundsByTx = new Map<string, number>();
  for (const refund of countedRefunds) {
    for (const key of [refund.transactionId, refund.transactionReference]) {
      if (!key) continue;
      refundsByTx.set(key, (refundsByTx.get(key) ?? 0) + refund.amountKobo);
    }
  }
  const refundedFor = (tx: NormalizedTransaction) => (tx.id ? refundsByTx.get(tx.id) : undefined) ?? refundsByTx.get(tx.reference) ?? 0;

  const totals = { paystackCollectedKobo: 0, paystackRefundedKobo: 0, ledgerFundedKobo: 0, ledgerRefundedKobo: 0 };

  for (const row of ledger) {
    const charges = row.chargeReferences ?? [];
    const funded = FUNDED_ESCROW_STATES.has(row.escrowStatus);
    const payments = paymentsByShipment.get(row.shipmentId) ?? [];
    const paystackRefs = charges.filter((ref) => ref.startsWith(PAYSTACK_ESCROW_PREFIX));
    const reviewOnly = charges.length > 0 && charges.every((ref) => ref.startsWith(PAYSTACK_REVIEW_PREFIX));

    if (funded) totals.ledgerFundedKobo += row.escrowAmountKobo;
    if (row.escrowStatus === 'REFUNDED') totals.ledgerRefundedKobo += row.escrowAmountKobo;
    for (const tx of payments) {
      totals.paystackCollectedKobo += tx.amountKobo;
      totals.paystackRefundedKobo += refundedFor(tx);
    }

    if (reviewOnly) {
      notes.push(item('store_review_payment', row, 'Paid through the store-review test key; not in this Paystack account.'));
      continue;
    }

    // The payment that funded the escrow is the one whose reference Trako recorded; any other
    // successful charge for the same shipment is extra money the customer paid twice.
    const payment = payments.find((tx) => charges.includes(tx.reference)) ?? payments[0];
    if (payments.length > 1) {
      const unrefundedExtras = payments.filter((tx) => tx !== payment && refundedFor(tx) < tx.amountKobo);
      if (unrefundedExtras.length) {
        problems.push(item('duplicate_payment', row, `Paid ${payments.length} times on Paystack (${payments.map((tx) => tx.reference).join(', ')}); refund ${unrefundedExtras.map((tx) => tx.reference).join(', ')}.`));
      }
    }

    if (payment && !funded) {
      problems.push(item('paid_not_funded', row, `Paystack ${payment.reference} succeeded but the escrow is ${row.escrowStatus}; verify the payment from the shipment page.`));
    }
    if (payment && funded && payment.amountKobo !== row.escrowAmountKobo) {
      problems.push(item('amount_mismatch', row, `Paystack collected ${payment.amountKobo} kobo, escrow holds ${row.escrowAmountKobo} kobo.`));
    }
    if (!payment && funded) {
      if (paystackRefs.length) {
        problems.push(item('paystack_payment_missing', row, `Escrow is ${row.escrowStatus} with charge ${paystackRefs[0]}, but Paystack shows no successful payment for it.`));
      } else {
        notes.push(item('funded_outside_paystack', row, `Escrow is ${row.escrowStatus} with no Paystack charge (demo, mock or manual funding).`));
      }
    }

    if (payment) {
      const refunded = refundedFor(payment);
      if (payment.status === 'reversed' && refunded === 0) {
        // Reversed with no refund on record: a chargeback, or a refund older than the listing.
        // Money went back to the customer, which is only right when Trako refunded too.
        if (row.escrowStatus !== 'REFUNDED') {
          problems.push(item('payment_reversed', row, `Paystack reversed ${payment.reference} (money back to the customer) but the escrow is ${row.escrowStatus}; check for a chargeback before releasing.`));
        }
      } else if (row.escrowStatus === 'REFUNDED' && refunded === 0) {
        problems.push(item('refund_not_sent', row, `Escrow is REFUNDED but Paystack has no refund for ${payment.reference}; refund it in the Paystack dashboard.`));
      } else if (row.escrowStatus === 'REFUNDED' && refunded < payment.amountKobo) {
        problems.push(item('refund_partial', row, `Paystack refunded ${refunded} of ${payment.amountKobo} kobo for ${payment.reference}.`));
      } else if (row.escrowStatus !== 'REFUNDED' && refunded > 0) {
        problems.push(item('refund_not_in_ledger', row, `Paystack refunded ${refunded} kobo for ${payment.reference} but the escrow is ${row.escrowStatus}.`));
      }
    }
  }

  return { problems, notes, totals, counts: { paystackPayments: successes.length, paystackRefunds: countedRefunds.length, ledgerRows: ledger.length } };
}

// Ledger rows that say Paystack took the money but whose payment was not in the listed window
// (for example paid just before `from`). Callers verify these references one by one.
export function referencesToVerify(input: { transactions?: PaystackTransaction[]; ledger?: LedgerRow[] }): string[] {
  const { transactions = [], ledger = [] } = input;
  const seen = new Set(transactions.map(normalizeTransaction).filter((tx) => PAID_STATUSES.has(tx.status)).map((tx) => tx.reference));
  const refs: string[] = [];
  for (const row of ledger) {
    if (!FUNDED_ESCROW_STATES.has(row.escrowStatus)) continue;
    for (const ref of row.chargeReferences ?? []) {
      if (ref.startsWith(PAYSTACK_ESCROW_PREFIX) && !seen.has(ref)) refs.push(ref);
    }
  }
  return refs;
}

const formatNaira = (kobo: number) =>
  `NGN ${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatReconciliationReport(result: ReconciliationResult, window: { from: string; to: string; mode: string }) {
  const lines: string[] = [];
  lines.push(`Paystack reconciliation (${window.mode} mode), ${window.from} to ${window.to}`);
  lines.push(`Paystack: ${result.counts.paystackPayments} payments, ${result.counts.paystackRefunds} refunds. Ledger: ${result.counts.ledgerRows} escrows.`);
  const t = result.totals;
  lines.push(`Collected   Paystack ${formatNaira(t.paystackCollectedKobo)}   ledger ${formatNaira(t.ledgerFundedKobo)}`);
  lines.push(`Refunded    Paystack ${formatNaira(t.paystackRefundedKobo)}   ledger ${formatNaira(t.ledgerRefundedKobo)}`);
  lines.push('');
  if (!result.problems.length) lines.push('No problems: every Paystack payment and refund matches the ledger.');
  else {
    lines.push(`${result.problems.length} problem(s) to resolve:`);
    for (const p of result.problems) lines.push(`  [${p.type}] ${p.shipmentReference ?? p.shipmentId ?? '-'}: ${p.detail}`);
  }
  if (result.notes.length) {
    const byType = result.notes.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }), {});
    lines.push('');
    lines.push(`Notes (expected, no action): ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  return lines.join('\n');
}
