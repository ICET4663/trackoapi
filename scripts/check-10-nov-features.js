// Live checks for the features deployed on 10 Nov 2026 (API 1f350e0): closed-test sandbox
// addresses, bank-transfer payouts, and the pending-payment sweep. Read-only: it changes nothing.
//
//   S1  public sign-up refuses a reserved tester address (refused before any code is sent, so no
//       email, SMS or rate-limit entry is created)
//   S2  public sign-up refuses a reserved store-review address
//   P1  the admin payout list carries the new fields (paidBy, transferStatus, transferReference,
//       transferFailed) on every payout
//   P2  shows the 6 Nov payout that Paystack Starter refused (driver@, test money), so the owner
//       can decide: record a bank transfer in Finance, or reject it
//   W1  no GitHub dispatch-sweep run has failed since the deploy. GitHub runs it only every few
//       hours, so the every-5-minutes trigger is the Supabase job (docs/dispatch-sweep-schedule.md),
//       checked in the Supabase SQL editor
//
// Needs an admin login for P1/P2 (skipped without one):
//
//   $env:API_BASE_URL="https://trackoapi.vercel.app"; $env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."
//   node scripts/check-10-nov-features.js
//
// The paid-checkout part of the sweep needs a person: start a checkout as the demo customer, pay
// with the Paystack test card in your own browser, close the tab without returning, and the
// shipment should be ESCROW_FUNDED within about 5 minutes.

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const STUCK_PAYOUT = process.env.STUCK_PAYOUT_ID || 'cmw54cqpq000mjq0kxh0ibzg9';
const DEPLOYED_AT = new Date(process.env.DEPLOYED_AT || '2026-11-10T09:55:00Z');
const SWEEP_RUNS = 'https://api.github.com/repos/ICET4663/trackoapi/actions/workflows/dispatch-sweep.yml/runs?per_page=30';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(3)} ${name}${detail ? `  (${detail})` : ''}`);
}
function skip(id, name, why) {
  console.log(`SKIP  ${id.padEnd(3)} ${name}  (${why})`);
}
async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 200) }; }
  return { status: response.status, ok: response.ok, payload };
}
const message = (payload) => [].concat(payload?.message ?? '').join(' ');

async function reservedSignUp(id, email) {
  const result = await request('/v1/auth/register/request', {
    method: 'POST',
    body: { email, phone: '+2348030000000', role: 'CUSTOMER' },
  });
  check(id, `sign-up refuses reserved ${email}`, result.status === 400 && /reserved/i.test(message(result.payload)), `${result.status} ${message(result.payload)}`);
}

async function payouts() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    skip('P1', 'payout list fields', 'set ADMIN_EMAIL and ADMIN_PASSWORD');
    skip('P2', 'stuck 6 Nov payout', 'set ADMIN_EMAIL and ADMIN_PASSWORD');
    return;
  }
  const login = await request('/v1/auth/login', { method: 'POST', body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'ADMIN' } });
  if (!login.ok) throw new Error(`Admin sign-in failed (${login.status}): ${message(login.payload)}`);
  const list = await request('/v1/admin/payout-requests', { token: login.payload.accessToken });
  const items = Array.isArray(list.payload) ? list.payload : [];
  const fields = ['paidBy', 'transferStatus', 'transferReference', 'transferFailed'];
  const missing = items.filter((item) => fields.some((field) => !(field in item)));
  check('P1', 'every payout carries paidBy / transferStatus / transferReference / transferFailed',
    list.ok && items.length > 0 && missing.length === 0, `${list.status}, ${items.length} payouts, ${missing.length} missing fields`);
  for (const status of ['APPROVED', 'PAID']) {
    const count = items.filter((item) => item.status === status).length;
    if (count) console.log(`      ${count} ${status}${status === 'PAID' ? ` (bank transfer: ${items.filter((item) => item.paidBy === 'BANK_TRANSFER').length}, failed Paystack transfer: ${items.filter((item) => item.transferFailed).length})` : ''}`);
  }
  const stuck = items.find((item) => item.id === STUCK_PAYOUT);
  check('P2', `6 Nov payout ${STUCK_PAYOUT} is listed`, Boolean(stuck),
    stuck ? `${stuck.status}, ${stuck.amountLabel}, ${stuck.driverEmail}${stuck.paidBy ? `, paid by ${stuck.paidBy}` : ''}` : 'not in the latest 100');
}

async function sweep() {
  const response = await fetch(SWEEP_RUNS, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'trako-live-check' } });
  if (!response.ok) {
    skip('W1', 'dispatch sweep runs', `GitHub API ${response.status}`);
    return;
  }
  const runs = ((await response.json()).workflow_runs ?? []).filter((run) => new Date(run.created_at) > DEPLOYED_AT && run.status === 'completed');
  const failed = runs.filter((run) => run.conclusion !== 'success');
  check('W1', 'no GitHub dispatch-sweep run failed since the deploy', failed.length === 0,
    `${runs.length} completed, ${failed.length} not green${failed[0] ? `, e.g. ${failed[0].html_url}` : ''}`);
}

async function main() {
  console.log(`10 Nov features against ${API_BASE_URL}\n`);
  await reservedSignUp('S1', 'tester01.customer@trako.com.ng');
  await reservedSignUp('S2', 'google.review.driver@trako.com.ng');
  await payouts();
  await sweep();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nStopped: ${error.message}`);
  process.exit(1);
});
