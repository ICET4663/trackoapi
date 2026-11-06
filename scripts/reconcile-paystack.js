// Weekly payment reconciliation: Paystack's successful payments and refunds against Trako's escrow
// ledger, for a date window (default: the last 7 days). Read-only on both sides: it lists and
// verifies Paystack transactions and reads the database; it never charges, refunds or transfers.
// Exits 1 when there is a problem for finance to resolve, so it can run on a schedule.
//
// The deployed API runs the same comparison every Monday and on demand from the admin Finance
// screen (PaymentReconciliationService); this runner is for a local or custom window.
// Usage (API repo, PAYSTACK_SECRET_KEY and DATABASE_URL in .env):
//   node scripts/reconcile-paystack.js                      last 7 days
//   node scripts/reconcile-paystack.js --from 2026-10-01 --to 2026-10-31
//   node scripts/reconcile-paystack.js --json report.json   also write the full result
require('dotenv').config();
// The comparison itself is shared with the API (src/integrations/paystack-reconciliation.ts).
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const fs = require('node:fs');
const { PrismaClient } = require('@prisma/client');
const {
  reconcilePaystack: reconcile,
  referencesToVerify,
  formatReconciliationReport: formatReport,
} = require('../src/integrations/paystack-reconciliation');

const PAYSTACK = 'https://api.paystack.co';
const DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (['--from', '--to', '--json'].includes(flag)) args[flag.slice(2)] = argv[(i += 1)];
    else throw new Error(`Unknown option ${flag}. Use --from YYYY-MM-DD, --to YYYY-MM-DD, --json file.`);
  }
  const to = args.to ? new Date(`${args.to}T23:59:59.999Z`) : new Date();
  const from = args.from ? new Date(`${args.from}T00:00:00.000Z`) : new Date(to.getTime() - 7 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw new Error('Invalid --from/--to dates.');
  return { from, to, json: args.json };
}

async function paystackGet(secretKey, path) {
  const response = await fetch(`${PAYSTACK}${path}`, { headers: { Authorization: `Bearer ${secretKey}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) {
    const error = new Error(`Paystack ${path.split('?')[0]} failed (${response.status}): ${payload.message ?? 'no message'}`);
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}

async function listAll(secretKey, path, query) {
  const rows = [];
  for (let page = 1; page <= 500; page += 1) {
    const params = new URLSearchParams({ ...query, perPage: '100', page: String(page) });
    const payload = await paystackGet(secretKey, `${path}?${params}`);
    rows.push(...(payload.data ?? []));
    const pageCount = Number(payload.meta?.pageCount ?? payload.meta?.page_count ?? 1);
    if (page >= pageCount || !(payload.data ?? []).length) break;
  }
  return rows;
}

async function loadLedger(prisma, from, to, shipmentIds) {
  return prisma.$queryRawUnsafe(
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
}

async function main() {
  const { from, to, json } = parseArgs(process.argv.slice(2));
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error('PAYSTACK_SECRET_KEY is not set; nothing to reconcile against.');
  const mode = secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : 'unknown';
  const window = { from: from.toISOString(), to: to.toISOString() };

  // Refunded payments leave the "success" list (Paystack marks them "reversed"), so read both.
  const transactions = [
    ...(await listAll(secretKey, '/transaction', { status: 'success', ...window })),
    ...(await listAll(secretKey, '/transaction', { status: 'reversed', ...window })),
  ];
  const refunds = await listAll(secretKey, '/refund', window);

  const prisma = new PrismaClient();
  try {
    const shipmentIds = [...new Set(transactions.map((tx) => {
      const meta = typeof tx.metadata === 'string' ? (() => { try { return JSON.parse(tx.metadata); } catch { return {}; } })() : tx.metadata;
      return meta?.shipmentId;
    }).filter(Boolean))];
    const ledger = await loadLedger(prisma, from, to, shipmentIds);

    // Charges Trako recorded whose payment fell outside the listing window: look each one up.
    for (const reference of referencesToVerify({ transactions, ledger })) {
      try {
        const payload = await paystackGet(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
        if (payload.data) transactions.push(payload.data);
      } catch (error) {
        if (error.httpStatus !== 400 && error.httpStatus !== 404) throw error; // not found: reported as missing
      }
    }
    // Refunds for those older payments may predate the window as well.
    if (transactions.some((tx) => new Date(tx.paid_at ?? tx.paidAt ?? to) < from)) {
      const earliest = transactions.reduce((min, tx) => Math.min(min, new Date(tx.paid_at ?? tx.paidAt ?? to).getTime()), from.getTime());
      const known = new Set(refunds.map((r) => String(r.id)));
      for (const refund of await listAll(secretKey, '/refund', { from: new Date(earliest).toISOString(), to: window.from })) {
        if (!known.has(String(refund.id))) refunds.push(refund);
      }
    }

    const result = reconcile({ transactions, refunds, ledger });
    console.log(formatReport(result, { from: window.from.slice(0, 10), to: window.to.slice(0, 10), mode }));
    if (json) {
      fs.writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), mode, ...window, ...result }, null, 2));
      console.log(`\nFull result written to ${json}`);
    }
    process.exitCode = result.problems.length ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Reconciliation did not run: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs };
