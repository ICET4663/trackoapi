import * as assert from 'node:assert/strict';
import {
  formatReconciliationReport as formatReport,
  type LedgerRow,
  reconcilePaystack as reconcile,
  referencesToVerify,
} from './paystack-reconciliation';

const tx = (over: Record<string, unknown> = {}) => ({
  id: 101,
  reference: 'tracko_escrow_1',
  status: 'success',
  amount: 500000,
  currency: 'NGN',
  metadata: { shipmentId: 'shp1', purpose: 'shipment_escrow' },
  ...over,
});
const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  shipmentId: 'shp1',
  shipmentReference: 'TRK-1',
  escrowStatus: 'FUNDED',
  escrowAmountKobo: 500000,
  chargeReferences: ['tracko_escrow_1'],
  ...over,
});
const types = (list: Array<{ type: string }>) => list.map((item) => item.type);

test('a matching payment gives no problems and equal totals', () => {
  const result = reconcile({ transactions: [tx()], ledger: [row()] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.totals.paystackCollectedKobo, 500000);
  assert.equal(result.totals.ledgerFundedKobo, 500000);
});

test('metadata sent as a JSON string is understood', () => {
  const result = reconcile({ transactions: [tx({ metadata: JSON.stringify({ shipmentId: 'shp1', purpose: 'shipment_escrow' }) })], ledger: [row()] });
  assert.deepEqual(result.problems, []);
});

test('falls back to the recorded charge reference when metadata is missing', () => {
  const result = reconcile({ transactions: [tx({ metadata: null })], ledger: [row()] });
  assert.deepEqual(result.problems, []);
});

test('Paystack success with the escrow still pending is flagged', () => {
  const result = reconcile({ transactions: [tx()], ledger: [row({ escrowStatus: 'PENDING', chargeReferences: [] })] });
  assert.deepEqual(types(result.problems), ['paid_not_funded']);
});

test('different amounts are flagged', () => {
  const result = reconcile({ transactions: [tx({ amount: 400000 })], ledger: [row()] });
  assert.deepEqual(types(result.problems), ['amount_mismatch']);
});

test('a second unrefunded charge for one shipment is a duplicate payment', () => {
  const result = reconcile({ transactions: [tx(), tx({ id: 102, reference: 'tracko_escrow_2' })], ledger: [row()] });
  assert.deepEqual(types(result.problems), ['duplicate_payment']);
});

test('a duplicate that was refunded in full is not a problem', () => {
  const result = reconcile({
    transactions: [tx(), tx({ id: 102, reference: 'tracko_escrow_2' })],
    refunds: [{ id: 9, transaction: 102, amount: 500000, status: 'processed' }],
    ledger: [row()],
  });
  assert.deepEqual(result.problems, []);
});

test('the charge Trako recorded is the primary one even when the duplicate came first', () => {
  const result = reconcile({ transactions: [tx({ id: 100, reference: 'tracko_escrow_0', amount: 1 }), tx()], ledger: [row()] });
  assert.deepEqual(types(result.problems), ['duplicate_payment']);
  assert.match(result.problems[0].detail, /refund tracko_escrow_0/);
});

test('ledger funded with a Paystack charge Paystack never confirmed is flagged', () => {
  const result = reconcile({ transactions: [], ledger: [row()] });
  assert.deepEqual(types(result.problems), ['paystack_payment_missing']);
});

test('demo or mock funding is a note, not a problem', () => {
  const result = reconcile({ transactions: [], ledger: [row({ chargeReferences: ['mock_TRK-1'] })] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(types(result.notes), ['funded_outside_paystack']);
});

test('store-review payments are noted and skipped', () => {
  const result = reconcile({
    transactions: [tx({ reference: 'tracko_review_1', metadata: { shipmentId: 'zzz' } })],
    ledger: [row({ chargeReferences: ['tracko_review_1'] })],
  });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(types(result.notes), ['store_review_payment']);
});

test('a REFUNDED escrow with no Paystack refund means the money was never sent back', () => {
  const result = reconcile({ transactions: [tx()], ledger: [row({ escrowStatus: 'REFUNDED' })] });
  assert.deepEqual(types(result.problems), ['refund_not_sent']);
});

test('a full Paystack refund matches a REFUNDED escrow, by transaction id or object', () => {
  for (const transaction of [101, { id: 101, reference: 'tracko_escrow_1' }]) {
    const result = reconcile({ transactions: [tx()], refunds: [{ id: 1, transaction, amount: 500000, status: 'processed' }], ledger: [row({ escrowStatus: 'REFUNDED' })] });
    assert.deepEqual(result.problems, []);
    assert.equal(result.totals.paystackRefundedKobo, 500000);
    assert.equal(result.totals.ledgerRefundedKobo, 500000);
  }
});

test('a pending refund counts; a failed refund does not', () => {
  const pending = reconcile({ transactions: [tx()], refunds: [{ transaction: 101, amount: 500000, status: 'pending' }], ledger: [row({ escrowStatus: 'REFUNDED' })] });
  assert.deepEqual(pending.problems, []);
  const failed = reconcile({ transactions: [tx()], refunds: [{ transaction: 101, amount: 500000, status: 'failed' }], ledger: [row({ escrowStatus: 'REFUNDED' })] });
  assert.deepEqual(types(failed.problems), ['refund_not_sent']);
});

test('a partial refund is flagged', () => {
  const result = reconcile({ transactions: [tx()], refunds: [{ transaction: 101, amount: 100000, status: 'processed' }], ledger: [row({ escrowStatus: 'REFUNDED' })] });
  assert.deepEqual(types(result.problems), ['refund_partial']);
});

test('a Paystack refund on an escrow Trako still holds is flagged', () => {
  const result = reconcile({ transactions: [tx()], refunds: [{ transaction: 101, amount: 500000, status: 'processed' }], ledger: [row({ escrowStatus: 'HELD' })] });
  assert.deepEqual(types(result.problems), ['refund_not_in_ledger']);
});

test('a Trako payment for a shipment that does not exist is flagged', () => {
  const result = reconcile({ transactions: [tx({ metadata: { shipmentId: 'gone', purpose: 'shipment_escrow' }, reference: 'tracko_escrow_9' })], ledger: [] });
  assert.deepEqual(types(result.problems), ['paid_unknown_shipment']);
});

test('payments that are not Trako escrow payments are ignored', () => {
  const result = reconcile({ transactions: [tx({ reference: 'other_1', metadata: {} })], ledger: [] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.counts.paystackPayments, 0);
});

test('referencesToVerify lists funded Paystack charges missing from the listing', () => {
  assert.deepEqual(referencesToVerify({ transactions: [], ledger: [row(), row({ shipmentId: 's2', chargeReferences: ['mock_x'] }), row({ shipmentId: 's3', escrowStatus: 'PENDING', chargeReferences: ['tracko_escrow_3'] })] }), ['tracko_escrow_1']);
  assert.deepEqual(referencesToVerify({ transactions: [tx()], ledger: [row()] }), []);
});

test('the report names each problem and the totals', () => {
  const text = formatReport(reconcile({ transactions: [tx({ amount: 400000 })], ledger: [row()] }), { from: '2026-10-30', to: '2026-11-06', mode: 'test' });
  assert.match(text, /test mode/);
  assert.match(text, /\[amount_mismatch\] TRK-1/);
  assert.match(text, /NGN 4,000\.00/);
});

// Paystack marks a refunded payment "reversed" and drops it from the "success" list.
test('a reversed payment with its refund matches a REFUNDED escrow (live case, 20 Oct)', () => {
  const result = reconcile({
    transactions: [tx({ status: 'reversed' })],
    refunds: [{ id: 7, transaction: 101, amount: 500000, status: 'pending' }],
    ledger: [row({ escrowStatus: 'REFUNDED' })],
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.totals.paystackRefundedKobo, 500000);
});

test('a reversed payment whose refund predates the listing still matches a REFUNDED escrow', () => {
  const result = reconcile({ transactions: [tx({ status: 'reversed' })], ledger: [row({ escrowStatus: 'REFUNDED' })] });
  assert.deepEqual(result.problems, []);
});

test('a reversal Trako did not make (chargeback) on a held escrow is flagged', () => {
  const result = reconcile({ transactions: [tx({ status: 'reversed' })], ledger: [row({ escrowStatus: 'HELD' })] });
  assert.deepEqual(types(result.problems), ['payment_reversed']);
});

test('failed or abandoned payments still do not count as paid', () => {
  const result = reconcile({ transactions: [tx({ status: 'failed' }), tx({ id: 2, status: 'abandoned' })], ledger: [row({ escrowStatus: 'PENDING', chargeReferences: [] })] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.counts.paystackPayments, 0);
});

test('referencesToVerify does not look up a payment already listed as reversed', () => {
  assert.deepEqual(referencesToVerify({ transactions: [tx({ status: 'reversed' })], ledger: [row({ escrowStatus: 'REFUNDED' })] }), []);
});
