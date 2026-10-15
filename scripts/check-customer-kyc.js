// Customer KYC correction loop against a deployed API (TRACKO_ACCEPTANCE.md K2): the
// customer submits identity details, an admin asks for a correction with a reason, the
// customer sees the reason and cannot book meanwhile, resubmits, and the admin approves.
//
// Uses the demo customer, which is already verified. Whatever happens, the last step
// approves it again, so the demo account always ends VERIFIED.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/check-customer-kyc.js

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.SIM_PASSWORD || 'password123';
const CUSTOMER_EMAIL = process.env.SIM_CUSTOMER_EMAIL || 'customer@tracko.ng';
const ADMIN_EMAIL = process.env.SIM_ADMIN_EMAIL || 'admin@tracko.ng';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? `  (${detail})` : ''}`);
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
async function login(identifier, role) {
  const result = await request('/v1/auth/login', { method: 'POST', body: { identifier, password: PASSWORD, role } });
  if (!result.ok) throw new Error(`${identifier} could not sign in (${result.status}).`);
  return result.payload;
}
const kycOf = async (token) => (await request('/v1/kyc', { token })).payload;
const statusOf = (kyc) => kyc?.status ?? kyc?.submission?.status ?? kyc?.latest?.status;
const noteOf = (kyc) => kyc?.note ?? kyc?.submission?.note ?? kyc?.latest?.note ?? kyc?.reviewNote;

async function main() {
  console.log(`Customer KYC correction loop against ${API_BASE_URL} (${CUSTOMER_EMAIL})\n`);
  const customerSession = await login(CUSTOMER_EMAIL, 'CUSTOMER');
  const customer = customerSession.accessToken;
  const customerId = customerSession.user?.id;
  const admin = (await login(ADMIN_EMAIL, 'ADMIN')).accessToken;
  if (!customerId) throw new Error('The sign-in response did not include the customer id.');

  try {
    const submitted = await request('/v1/kyc', { method: 'POST', token: customer, body: { idType: 'NIN', idNumber: '12345678901', note: 'Acceptance check K2 (demo)' } });
    check('K2a', 'customer submits identity details for review', submitted.ok, `${submitted.status} ${statusOf(submitted.payload) ?? ''}`);

    const reason = 'The NIN does not match the name on your account - please re-enter it (acceptance check)';
    const correction = await request(`/v1/admin/verifications/${encodeURIComponent(customerId)}`, { method: 'POST', token: admin, body: { action: 'REQUEST_CORRECTION', note: reason } });
    const afterCorrection = await kycOf(customer);
    const me = (await request('/v1/auth/me', { token: customer })).payload;
    check('K2b', 'admin asks for a correction; the customer sees the reason and their account needs action',
      correction.ok && statusOf(afterCorrection) === 'CORRECTION_REQUIRED' && noteOf(afterCorrection) === reason && me?.verificationStatus === 'ACTION_NEEDED',
      `${statusOf(afterCorrection)}, account ${me?.verificationStatus}, reason ${noteOf(afterCorrection) === reason ? 'shown' : `"${noteOf(afterCorrection) ?? 'missing'}"`}`);

    const booking = await request('/v1/shipments', { method: 'POST', token: customer, body: { origin: 'Ikeja', destination: 'Ibadan', cargoType: 'K2 check (demo)' } });
    check('K2c', 'a customer whose identity needs correcting cannot book', !booking.ok, `${booking.status} ${booking.payload?.message ?? ''}`);
    if (booking.ok && booking.payload?.id) {
      await request(`/v1/shipments/${booking.payload.id}/status`, { method: 'PATCH', token: customer, body: { status: 'CANCELLED', note: 'K2 check cleanup' } });
    }

    const resubmitted = await request('/v1/kyc', { method: 'POST', token: customer, body: { idType: 'NIN', idNumber: '10987654321', note: 'Corrected NIN (acceptance check)' } });
    check('K2d', 'customer resubmits the corrected details', resubmitted.ok && ['PENDING', 'IN_REVIEW'].includes(statusOf(await kycOf(customer)) ?? 'PENDING'), `${resubmitted.status} ${statusOf(await kycOf(customer))}`);
  } finally {
    const approved = await request(`/v1/admin/verifications/${encodeURIComponent(customerId)}`, { method: 'POST', token: admin, body: { action: 'APPROVE', note: 'Corrected details checked (acceptance check)' } });
    const me = (await request('/v1/auth/me', { token: customer })).payload;
    check('K2e', 'admin approves; the customer is verified again', approved.ok && me?.verificationStatus === 'VERIFIED', `account ${me?.verificationStatus}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
