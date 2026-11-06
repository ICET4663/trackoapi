// Compares Trako's escrow ledger with Paystack's own records (launch gap: "weekly compare of the
// Paystack dashboard against the admin escrow ledger" before live mode). Pure functions only; the
// runner in scripts/reconcile-paystack.js fetches both sides and prints the report.
//
// Problems are differences someone in finance has to act on. Notes are expected differences that
// are listed so the totals can be explained (demo or mock funding, store-review payments).

const PAYSTACK_PREFIX = 'tracko_escrow_';
const REVIEW_PREFIX = 'tracko_review_';
// Escrow states that mean the customer's money arrived at some point.
const FUNDED_STATES = new Set(['FUNDED', 'HELD', 'RELEASE_READY', 'RELEASED', 'DISPUTED', 'REFUNDED']);

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) ?? {};
    } catch {
      return {};
    }
  }
  return typeof metadata === 'object' ? metadata : {};
}

function normalizeTransaction(tx) {
  const metadata = parseMetadata(tx.metadata);
  return {
    id: tx.id == null ? null : String(tx.id),
    reference: String(tx.reference ?? ''),
    status: String(tx.status ?? ''),
    amountKobo: Number(tx.amount ?? 0),
    currency: tx.currency ?? 'NGN',
    paidAt: tx.paid_at ?? tx.paidAt ?? null,
    shipmentId: metadata.shipmentId ?? null,
    purpose: metadata.purpose ?? null,
  };
}

function normalizeRefund(refund) {
  const tx = refund.transaction;
  const txObject = tx && typeof tx === 'object' ? tx : null;
  return {
    id: refund.id == null ? null : String(refund.id),
    transactionId: txObject ? String(txObject.id ?? '') : tx == null ? null : String(tx),
    transactionReference: txObject?.reference ?? refund.transaction_reference ?? null,
    amountKobo: Number(refund.amount ?? 0),
    status: String(refund.status ?? ''),
  };
}

const isTrakoEscrowPayment = (tx) =>
  tx.purpose === 'shipment_escrow' || tx.reference.startsWith(PAYSTACK_PREFIX) || tx.reference.startsWith(REVIEW_PREFIX);

// A Paystack refund counts once it is not failed; "pending"/"processing" means money is on its way back.
const refundCounts = (refund) => !/failed|reversed/i.test(refund.status);

/**
 * @param {object} input
 * @param {Array} input.transactions Paystack transactions (raw API objects)
 * @param {Array} input.refunds Paystack refunds (raw API objects)
 * @param {Array} input.ledger rows: { shipmentId, shipmentReference, escrowStatus, escrowAmountKobo, chargeReferences: string[] }
 */
function reconcile({ transactions = [], refunds = [], ledger = [] }) {
  const problems = [];
  const notes = [];
  const add = (list, type, row, detail) =>
    list.push({ type, shipmentId: row?.shipmentId ?? null, shipmentReference: row?.shipmentReference ?? null, detail });

  const successes = transactions
    .map(normalizeTransaction)
    .filter((tx) => tx.status === 'success' && isTrakoEscrowPayment(tx));
  const countedRefunds = refunds.map(normalizeRefund).filter(refundCounts);

  const ledgerById = new Map(ledger.map((row) => [row.shipmentId, row]));
  const ledgerByChargeRef = new Map();
  for (const row of ledger) for (const ref of row.chargeReferences ?? []) ledgerByChargeRef.set(ref, row);

  // Group Paystack payments by shipment (metadata first, then the charge reference we recorded).
  const paymentsByShipment = new Map();
  for (const tx of successes) {
    const row = (tx.shipmentId && ledgerById.get(tx.shipmentId)) || ledgerByChargeRef.get(tx.reference);
    if (!row) {
      if (tx.reference.startsWith(REVIEW_PREFIX)) continue;
      add(problems, 'paid_unknown_shipment', { shipmentId: tx.shipmentId }, `Paystack ${tx.reference} received ${tx.amountKobo} kobo for a shipment Trako does not have.`);
      continue;
    }
    const list = paymentsByShipment.get(row.shipmentId) ?? [];
    list.push(tx);
    paymentsByShipment.set(row.shipmentId, list);
  }

  const refundsByTx = new Map();
  for (const refund of countedRefunds) {
    for (const key of [refund.transactionId, refund.transactionReference]) {
      if (!key) continue;
      refundsByTx.set(key, (refundsByTx.get(key) ?? 0) + refund.amountKobo);
    }
  }
  const refundedFor = (tx) => refundsByTx.get(tx.id) ?? refundsByTx.get(tx.reference) ?? 0;

  const totals = { paystackCollectedKobo: 0, paystackRefundedKobo: 0, ledgerFundedKobo: 0, ledgerRefundedKobo: 0 };

  for (const row of ledger) {
    const funded = FUNDED_STATES.has(row.escrowStatus);
    const payments = paymentsByShipment.get(row.shipmentId) ?? [];
    const paystackRefs = (row.chargeReferences ?? []).filter((ref) => ref.startsWith(PAYSTACK_PREFIX));
    const reviewOnly = (row.chargeReferences ?? []).length > 0 && (row.chargeReferences ?? []).every((ref) => ref.startsWith(REVIEW_PREFIX));

    if (funded) totals.ledgerFundedKobo += row.escrowAmountKobo;
    if (row.escrowStatus === 'REFUNDED') totals.ledgerRefundedKobo += row.escrowAmountKobo;
    for (const tx of payments) {
      totals.paystackCollectedKobo += tx.amountKobo;
      totals.paystackRefundedKobo += refundedFor(tx);
    }

    if (reviewOnly) {
      add(notes, 'store_review_payment', row, 'Paid through the store-review test key; not in this Paystack account.');
      continue;
    }

    // The payment that funded the escrow is the one whose reference Trako recorded; any other
    // successful charge for the same shipment is extra money the customer paid twice.
    const payment = payments.find((tx) => (row.chargeReferences ?? []).includes(tx.reference)) ?? payments[0];
    if (payments.length > 1) {
      const unrefundedExtras = payments.filter((tx) => tx !== payment && refundedFor(tx) < tx.amountKobo);
      if (unrefundedExtras.length) {
        add(problems, 'duplicate_payment', row, `Paid ${payments.length} times on Paystack (${payments.map((tx) => tx.reference).join(', ')}); refund ${unrefundedExtras.map((tx) => tx.reference).join(', ')}.`);
      }
    }

    if (payment && !funded) {
      add(problems, 'paid_not_funded', row, `Paystack ${payment.reference} succeeded but the escrow is ${row.escrowStatus}; verify the payment from the shipment page.`);
    }
    if (payment && funded && payment.amountKobo !== row.escrowAmountKobo) {
      add(problems, 'amount_mismatch', row, `Paystack collected ${payment.amountKobo} kobo, escrow holds ${row.escrowAmountKobo} kobo.`);
    }
    if (!payment && funded) {
      if (paystackRefs.length) {
        add(problems, 'paystack_payment_missing', row, `Escrow is ${row.escrowStatus} with charge ${paystackRefs[0]}, but Paystack shows no successful payment for it.`);
      } else {
        add(notes, 'funded_outside_paystack', row, `Escrow is ${row.escrowStatus} with no Paystack charge (demo, mock or manual funding).`);
      }
    }

    if (payment) {
      const refunded = refundedFor(payment);
      if (row.escrowStatus === 'REFUNDED' && refunded === 0) {
        add(problems, 'refund_not_sent', row, `Escrow is REFUNDED but Paystack has no refund for ${payment.reference}; refund it in the Paystack dashboard.`);
      } else if (row.escrowStatus === 'REFUNDED' && refunded < payment.amountKobo) {
        add(problems, 'refund_partial', row, `Paystack refunded ${refunded} of ${payment.amountKobo} kobo for ${payment.reference}.`);
      } else if (row.escrowStatus !== 'REFUNDED' && refunded > 0) {
        add(problems, 'refund_not_in_ledger', row, `Paystack refunded ${refunded} kobo for ${payment.reference} but the escrow is ${row.escrowStatus}.`);
      }
    }
  }

  return { problems, notes, totals, counts: { paystackPayments: successes.length, paystackRefunds: countedRefunds.length, ledgerRows: ledger.length } };
}

// Ledger rows that say Paystack took the money but whose payment was not in the listed window
// (for example paid just before `from`). The runner verifies these references one by one.
function referencesToVerify({ transactions = [], ledger = [] }) {
  const seen = new Set(transactions.map(normalizeTransaction).filter((tx) => tx.status === 'success').map((tx) => tx.reference));
  const refs = [];
  for (const row of ledger) {
    if (!FUNDED_STATES.has(row.escrowStatus)) continue;
    for (const ref of row.chargeReferences ?? []) {
      if (ref.startsWith(PAYSTACK_PREFIX) && !seen.has(ref)) refs.push(ref);
    }
  }
  return refs;
}

const formatNaira = (kobo) => `NGN ${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatReport(result, { from, to, mode }) {
  const lines = [];
  lines.push(`Paystack reconciliation (${mode} mode), ${from} to ${to}`);
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
    const byType = result.notes.reduce((acc, n) => ({ ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }), {});
    lines.push('');
    lines.push(`Notes (expected, no action): ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { reconcile, referencesToVerify, formatReport, normalizeTransaction, normalizeRefund, FUNDED_STATES };
