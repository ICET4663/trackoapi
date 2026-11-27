// Live check of the 27 November 2026 input rules (fix/input-validation-2). Demo accounts only.
//
// Every refusal below happens before anything is saved. The only write is one saved address on
// the demo customer, which the script deletes again. It stops at the first check if the API is
// still running the old code, so nothing odd is ever written through it.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/check-27-nov-validation.js

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const DEFAULT_PASSWORD = process.env.SIM_PASSWORD || 'password123';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

async function request(urlPath, options = {}) {
  const response = await fetch(`${API_BASE_URL}${urlPath}`, {
    method: options.method || 'GET',
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
  return { status: response.status, ok: response.ok, payload };
}

function messageOf(result) {
  const message = result.payload?.message;
  return Array.isArray(message) ? message.join('; ') : String(message ?? '');
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SIM_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SIM_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const result = await request('/v1/auth/login', { method: 'POST', body: { identifier, password, role } });
  if (!result.ok || !result.payload.accessToken) throw new Error(`${role} login failed (${result.status}): ${messageOf(result)}`);
  return result.payload;
}

/** A 400 whose message contains `text`. */
function refused(name, result, text) {
  const message = messageOf(result);
  return check(name, result.status === 400 && message.includes(text), `${result.status} ${message.slice(0, 120)}`);
}

async function main() {
  console.log(`API: ${API_BASE_URL}\n`);
  const customer = await login('CUSTOMER', 'customer@tracko.ng');
  const driver = await login('DRIVER', 'driver@tracko.ng');
  const asCustomer = { accessToken: customer.accessToken };

  // Gate: the new rules are live. This request writes nothing on the old or the new code (the
  // sign-up code is wrong either way), so it is safe to run before the deploy has finished.
  const longName = await request('/v1/auth/register', {
    method: 'POST', body: { email: 'nobody@example.com', phone: '+2348000000000', fullName: 'x'.repeat(121), password: 'password123', code: '000000', role: 'CUSTOMER' },
  });
  if (!check('sign-up with a 121-character name is refused', longName.status === 400 && /Full name must be 2 to 120/.test(messageOf(longName)), `${longName.status} ${messageOf(longName).slice(0, 120)}`)) {
    throw new Error('The API is not running the 27 Nov rules yet; stopping before any other request.');
  }

  refused(
    'support ticket with an unknown channel is refused',
    await request('/v1/operations/support/tickets', { method: 'POST', ...asCustomer, body: { channel: 'FAX', topic: 'Validation check' } }),
    'support channel',
  );

  refused(
    'support ticket linked to a shipment that is not the customer\'s is refused',
    await request('/v1/operations/support/tickets', { method: 'POST', ...asCustomer, body: { topic: 'Validation check', shipmentId: 'TRK-0000000000000' } }),
    'not found on your account',
  );
  refused(
    'support ticket message over 4,000 characters is refused',
    await request('/v1/operations/support/tickets', { method: 'POST', ...asCustomer, body: { topic: 'Validation check', message: 'x'.repeat(4001) } }),
    '4,000',
  );
  refused(
    'dispute with an unknown priority is refused',
    await request('/v1/operations/disputes', { method: 'POST', ...asCustomer, body: { priority: 'CRITICAL', reason: 'Validation check' } }),
    'Priority must be one of',
  );

  refused(
    'saved address with no street line is refused',
    await request('/v1/customer/addresses', { method: 'POST', ...asCustomer, body: { label: 'Validation check', city: 'Lagos' } }),
    'Address is required',
  );
  const saved = await request('/v1/customer/addresses', {
    method: 'POST', ...asCustomer, body: { label: 'Validation check', line: '1 Check Street', city: 'Lagos', address: '1 Check Street, Lagos' },
  });
  check('a normal saved address still saves', saved.ok && Boolean(saved.payload?.id), `${saved.status}`);
  if (saved.payload?.id) {
    const removed = await request(`/v1/customer/addresses/${encodeURIComponent(saved.payload.id)}`, { method: 'DELETE', ...asCustomer });
    check('the check address is deleted again', removed.ok, `${removed.status}`);
  }

  refused(
    'profile photo that is not a link is refused',
    await request('/v1/account/profile', { method: 'PATCH', ...asCustomer, body: { avatarUrl: 'javascript:alert(1)' } }),
    'not a valid link',
  );
  refused(
    'blank profile name is refused',
    await request('/v1/account/profile', { method: 'PATCH', ...asCustomer, body: { fullName: ' ' } }),
    'Full name is required',
  );

  refused(
    'driver withdrawal under one kobo is refused',
    await request('/v1/driver/withdrawals', { method: 'POST', accessToken: driver.accessToken, body: { amountKobo: 0.4 } }),
    'Enter a valid withdrawal amount',
  );
  refused(
    'driver counter-offer too large to store is refused before the offer is looked up',
    await request('/v1/shipments/assignments/no-such-assignment/counter-offer', { method: 'POST', accessToken: driver.accessToken, body: { amountKobo: 3_000_000_000 } }),
    'too large',
  );

  refused(
    'password reset with a non-text identifier is a 400, not a 500',
    await request('/v1/auth/password-reset/confirm', { method: 'POST', body: { identifier: 12345, code: '000000', password: 'password123' } }),
    'required',
  );
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nStopped: ${error.message}`);
  process.exit(1);
});
