const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const DEFAULT_PASSWORD = process.env.SMOKE_PASSWORD || 'password123';
const MARK_PAID = String(process.env.SMOKE_MARK_PAYOUT_PAID || '').toLowerCase() === 'true';

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const attempts = method === 'GET' ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    if (response.ok) return payload;
    if (attempt < attempts && response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    throw new Error(`${method} ${path} failed (${response.status}): ${payload.message || text}`);
  }
  throw new Error(`${method} ${path} failed without a response.`);
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SMOKE_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SMOKE_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const session = await request('/v1/auth/login', {
    method: 'POST',
    body: { identifier, password, role },
  });
  if (!session.accessToken) throw new Error(`${role} login did not return an access token.`);
  return session;
}

function assertReconciled(summary, stage) {
  const delta = Number(summary?.escrow?.reconciliationDeltaKobo ?? Number.NaN);
  if (!Number.isFinite(delta)) throw new Error(`Finance summary did not return a reconciliation delta ${stage}.`);
  if (delta !== 0) throw new Error(`Escrow reconciliation is off by ${delta} kobo ${stage}.`);
  console.log(`OK finance reconciled ${stage}`, 'delta 0');
}

async function main() {
  console.log(`Tracko settlement smoke: ${API_BASE_URL}`);
  const [driver, admin] = await Promise.all([
    login('DRIVER', 'driver@tracko.ng'),
    login('ADMIN', 'admin@tracko.ng'),
  ]);
  console.log('OK driver and admin login');

  const before = await request('/v1/operations/finance-summary', { accessToken: admin.accessToken });
  assertReconciled(before, 'before settlement');

  let earnings = await request('/v1/driver/earnings', { accessToken: driver.accessToken });
  const driverEmail = driver.user?.email || process.env.SMOKE_DRIVER_EMAIL || 'driver@tracko.ng';
  const payouts = await request('/v1/admin/payout-requests', { accessToken: admin.accessToken });
  let payout = payouts.find((item) => item.driverEmail === driverEmail && ['PENDING', 'APPROVED'].includes(item.status));

  if (!payout) {
    if (!earnings.availableBalance || earnings.availableBalance <= 0) {
      const paid = payouts.find((item) => item.driverEmail === driverEmail && item.status === 'PAID');
      if (!paid) throw new Error('The driver has no available earnings and no completed payout to verify.');
      console.log('OK existing paid payout reused', paid.id);
      const finalSummary = await request('/v1/operations/finance-summary', { accessToken: admin.accessToken });
      assertReconciled(finalSummary, 'after settlement');
      console.log('DONE Tracko driver settlement was already complete');
      return;
    }

    const requestedAmount = Number(process.env.SMOKE_WITHDRAWAL_AMOUNT_KOBO || 1_000_000);
    const amountKobo = Math.min(earnings.availableBalance, requestedAmount);
    payout = await request('/v1/driver/withdrawals', {
      method: 'POST',
      accessToken: driver.accessToken,
      body: { amountKobo, note: 'Production test withdrawal from released escrow.' },
    });
    console.log('OK driver withdrawal requested', payout.id, payout.amountLabel);
  } else {
    console.log(`OK existing ${payout.status.toLowerCase()} payout reused`, payout.id);
  }

  if (payout.status === 'PENDING') {
    payout = await request(`/v1/admin/payout-requests/${encodeURIComponent(payout.id)}/review`, {
      method: 'POST',
      accessToken: admin.accessToken,
      body: { decision: 'APPROVED', note: 'Production test finance approval.' },
    });
    console.log('OK admin approved payout', payout.id);
  }

  if (!MARK_PAID) {
    const approvedSummary = await request('/v1/operations/finance-summary', { accessToken: admin.accessToken });
    assertReconciled(approvedSummary, 'after approval');
    console.log('OK approved payout awaiting disbursement', approvedSummary.payouts.approvedAwaitingDisbursementKobo);
    console.log('NEXT Confirm the simulated bank transfer, then rerun with SMOKE_MARK_PAYOUT_PAID=true.');
    console.log('DONE Tracko withdrawal is approved and awaiting disbursement');
    return;
  }

  payout = await request(`/v1/admin/payout-requests/${encodeURIComponent(payout.id)}/review`, {
    method: 'POST',
    accessToken: admin.accessToken,
    body: { decision: 'PAID', note: 'Production test payout marked paid after simulated transfer.' },
  });
  if (payout.status !== 'PAID') throw new Error(`Payout ended in ${payout.status}, not PAID.`);
  console.log('OK admin marked payout paid', payout.id);

  earnings = await request('/v1/driver/earnings', { accessToken: driver.accessToken });
  console.log('OK remaining driver balance', earnings.availableBalanceLabel || earnings.availableBalance);
  const after = await request('/v1/operations/finance-summary', { accessToken: admin.accessToken });
  assertReconciled(after, 'after settlement');
  console.log('DONE Tracko withdrawal, approval, payout and reconciliation passed');
}

main().catch((error) => {
  console.error('FAILED Tracko settlement smoke');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
