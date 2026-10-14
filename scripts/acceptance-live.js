// Acceptance checks for TRACKO_ACCEPTANCE.md (app repo) that can run against a deployed
// API with the demo accounts and no phone: sign-in, role boundaries, booking, payment
// set-up and webhook safety, tracking access and the planned route. The funded trip
// itself (assignment -> delivery -> release) is `npm run check:journey`.
//
// Writes only demo data: one or two demo-customer bookings and a Paystack TEST checkout
// that is never paid. Refuses to run if the API reports live (non-test) payments.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/acceptance-live.js [--json report.json]

const fs = require('fs');

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.SIM_PASSWORD || 'password123';
const ACCOUNTS = {
  CUSTOMER: process.env.SIM_CUSTOMER_EMAIL || 'customer@tracko.ng',
  DRIVER: process.env.SIM_DRIVER_EMAIL || 'driver@tracko.ng',
  TRUCK_OWNER: process.env.SIM_TRUCK_OWNER_EMAIL || 'truckowner@tracko.ng',
  DISPATCHER: process.env.SIM_DISPATCHER_EMAIL || 'dispatcher@tracko.ng',
  ADMIN: process.env.SIM_ADMIN_EMAIL || 'admin@tracko.ng',
};
// Ikeja City Mall -> Bodija Market, Ibadan: both picked from Google Places on the live app.
const PICKUP = { latitude: 6.6018, longitude: 3.3515 };
const DESTINATION = { latitude: 7.4167, longitude: 3.9167 };

const results = [];
function record(id, name, ok, detail = '') {
  const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  results.push({ id, name, status, detail });
  console.log(`${status.padEnd(4)}  ${id.padEnd(4)} ${name}${detail ? `  (${detail})` : ''}`);
}

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 200) }; }
  return { status: response.status, ok: response.ok, payload };
}

const denied = (status) => status === 401 || status === 403;
const message = (result) => `${result.status}${result.payload?.message ? ` ${String(result.payload.message).slice(0, 80)}` : ''}`;

async function check(id, name, task) {
  try {
    const outcome = await task();
    const [ok, detail] = Array.isArray(outcome) ? outcome : [outcome, ''];
    record(id, name, ok, detail);
  } catch (error) {
    record(id, name, false, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  console.log(`Trako acceptance (API) against ${API_BASE_URL}\n`);
  const sessions = {};

  // --- Sign-in and sessions ---------------------------------------------------------
  for (const [role, identifier] of Object.entries(ACCOUNTS)) {
    await check('A1', `${role.toLowerCase()} can sign in and gets its own role`, async () => {
      const login = await request('/v1/auth/login', { method: 'POST', body: { identifier, password: PASSWORD, role } });
      if (!login.ok) return [false, message(login)];
      sessions[role] = login.payload;
      const me = await request('/v1/auth/me', { token: login.payload.accessToken });
      return [me.ok && me.payload?.role === role, `me: ${me.payload?.role ?? message(me)}`];
    });
  }
  const token = (role) => sessions[role]?.accessToken;
  if (!token('CUSTOMER') || !token('ADMIN')) throw new Error('Demo customer and admin must be able to sign in.');

  const payments = await request('/v1/integrations/status', { token: token('ADMIN') });
  const paymentEnvironment = payments.payload?.payments?.environment ?? payments.payload?.payment?.environment;
  if (paymentEnvironment && paymentEnvironment !== 'test') {
    throw new Error(`Payments are in "${paymentEnvironment}" mode. This script only runs against Paystack test mode.`);
  }
  console.log(`      payments: ${payments.payload?.payments?.provider ?? '?'} / ${paymentEnvironment ?? 'unknown'} mode\n`);

  await check('A2', 'wrong password is refused', async () => {
    const result = await request('/v1/auth/login', { method: 'POST', body: { identifier: ACCOUNTS.CUSTOMER, password: `${PASSWORD}-wrong`, role: 'CUSTOMER' } });
    return [result.status === 401, message(result)];
  });
  await check('A3', 'customer credentials cannot open the admin portal', async () => {
    const result = await request('/v1/auth/login', { method: 'POST', body: { identifier: ACCOUNTS.CUSTOMER, password: PASSWORD, role: 'ADMIN' } });
    return [!result.ok || result.payload?.user?.role !== 'ADMIN', message(result)];
  });
  await check('A4', 'requests without a session are refused', async () => {
    const result = await request('/v1/shipments');
    return [denied(result.status), message(result)];
  });
  await check('A5', 'password reset does not reveal whether an account exists', async () => {
    const unknown = await request('/v1/auth/password-reset/request', { method: 'POST', body: { identifier: `nobody-${Date.now()}@example.com` } });
    return [unknown.status < 500 && !/not found|no account|does not exist/i.test(JSON.stringify(unknown.payload)), message(unknown)];
  });
  await check('A6', 'refresh issues a new session; logout revokes it', async () => {
    const login = await request('/v1/auth/login', { method: 'POST', body: { identifier: ACCOUNTS.CUSTOMER, password: PASSWORD, role: 'CUSTOMER' } });
    const refreshToken = login.payload?.refreshToken;
    if (!refreshToken) return [false, 'no refresh token returned'];
    const refreshed = await request('/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
    const next = refreshed.payload?.refreshToken ?? refreshToken;
    await request('/v1/auth/logout', { method: 'POST', body: { refreshToken: next } });
    const after = await request('/v1/auth/refresh', { method: 'POST', body: { refreshToken: next } });
    return [refreshed.ok && denied(after.status), `refresh ${refreshed.status}, after logout ${after.status}`];
  });

  // --- Role boundaries -------------------------------------------------------------
  await check('R1', 'customer cannot open operations data', async () => {
    const result = await request('/v1/operations/dashboard', { token: token('CUSTOMER') });
    return [denied(result.status), message(result)];
  });
  await check('R2', 'driver cannot open operations finance', async () => {
    const result = await request('/v1/operations/finance-summary', { token: token('DRIVER') });
    return [denied(result.status), message(result)];
  });
  await check('R3', 'truck owner cannot open the admin escrow ledger', async () => {
    const result = await request('/v1/operations/escrow-ledger', { token: token('TRUCK_OWNER') });
    return [denied(result.status), message(result)];
  });

  // --- Booking ----------------------------------------------------------------------
  let quote;
  await check('B1', 'route quote comes from Google Routes with a signed price', async () => {
    const result = await request('/v1/maps/route-estimate', {
      method: 'POST', token: token('CUSTOMER'),
      body: { originLatitude: PICKUP.latitude, originLongitude: PICKUP.longitude, destinationLatitude: DESTINATION.latitude, destinationLongitude: DESTINATION.longitude, truckType: 'Box truck', weightTons: 5 },
    });
    quote = result.payload;
    return [result.ok && quote?.quotedPriceKobo > 0 && Boolean(quote?.quoteToken), `${quote?.distanceKm} km, NGN ${(quote?.quotedPriceKobo ?? 0) / 100}, source ${quote?.source ?? quote?.provider ?? '?'}`];
  });

  const clientRequestId = `acceptance-${Date.now()}`;
  const booking = {
    origin: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Lagos',
    destination: 'Bodija Market, Ibadan, Oyo',
    originCoordinates: PICKUP,
    destinationCoordinates: DESTINATION,
    cargoType: 'Acceptance test cargo (demo)',
    quantity: '10 cartons',
    weightTons: 5,
    truckType: 'Box truck',
    pickupContactPhone: '+2348035550144',
    quoteToken: quote?.quoteToken,
    // A tampered price must be ignored: the API recomputes or verifies it.
    quotedPriceKobo: 100,
    clientRequestId,
  };
  let shipment;
  await check('B2', 'customer books a shipment at the server price (a client-sent price is ignored)', async () => {
    const result = await request('/v1/shipments', { method: 'POST', token: token('CUSTOMER'), body: booking });
    shipment = result.payload;
    if (!result.ok) return [false, message(result)];
    return [shipment.quotedPriceKobo === quote?.quotedPriceKobo && shipment.quotedPriceKobo !== 100, `${shipment.reference ?? shipment.id} ${shipment.status}, NGN ${shipment.quotedPriceKobo / 100}`];
  });
  await check('B3', 'retrying the same booking does not create a second shipment', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const retry = await request('/v1/shipments', { method: 'POST', token: token('CUSTOMER'), body: booking });
    return [retry.ok && retry.payload?.id === shipment.id, `retry gave ${retry.payload?.id === shipment.id ? 'the same shipment' : retry.payload?.reference ?? message(retry)}`];
  });
  await check('B4', 'a booking without pickup and destination is refused', async () => {
    const result = await request('/v1/shipments', { method: 'POST', token: token('CUSTOMER'), body: { cargoType: 'Nothing else' } });
    return [result.status === 400, message(result)];
  });
  await check('B5', 'customer sees the booking with both addresses and map coordinates', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const result = await request(`/v1/shipments/${shipment.id}`, { token: token('CUSTOMER') });
    const view = result.payload ?? {};
    return [result.ok && Boolean(view.originCoordinates && view.destinationCoordinates && view.origin && view.destination), `${view.origin} -> ${view.destination}`];
  });
  await check('B6', 'unassigned driver and truck owner cannot read the booking', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const driver = await request(`/v1/shipments/${shipment.id}`, { token: token('DRIVER') });
    const owner = await request(`/v1/shipments/${shipment.id}`, { token: token('TRUCK_OWNER') });
    return [denied(driver.status) && denied(owner.status), `driver ${driver.status}, truck owner ${owner.status}`];
  });

  // --- Payment set-up (Paystack test mode; never paid here) -------------------------
  let payment;
  await check('P1', 'payment starts a Paystack test checkout for the server amount', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const result = await request('/v1/payments/escrow/initialize', {
      method: 'POST', token: token('CUSTOMER'), body: { shipmentId: shipment.id, amount: 1, method: 'card' },
    });
    payment = result.payload && { ...result.payload, reference: result.payload.providerReference };
    const url = payment?.authorizationUrl;
    // The amount is in kobo and must be the booked price, not the 1 sent above.
    return [result.ok && /paystack\.(com|co)/.test(String(url)) && Boolean(payment?.reference) && payment?.amount === shipment.quotedPriceKobo, `${result.status}, amount ${payment?.amount ?? '?'} ${payment?.currency ?? ''}, checkout ${url ? new URL(url).host : 'missing'}`];
  });
  await check('P2', 'an unpaid checkout does not fund the shipment', async () => {
    if (!payment?.reference) return [null, 'no checkout'];
    const verify = await request(`/v1/payments/paystack/verify/${encodeURIComponent(payment.reference)}`, { token: token('CUSTOMER') });
    const escrow = await request(`/v1/shipments/${shipment.id}/escrow`, { token: token('CUSTOMER') });
    return [escrow.payload?.status === 'PENDING', `verify ${verify.status} ${verify.payload?.status ?? ''}, escrow ${escrow.payload?.status}`];
  });
  await check('P3', 'a forged Paystack webhook (bad signature) is refused and funds nothing', async () => {
    if (!payment?.reference) return [null, 'no checkout'];
    const forged = await request('/v1/payments/webhooks/paystack/charge.success', {
      method: 'POST', headers: { 'x-paystack-signature': '0'.repeat(128) },
      body: { event: 'charge.success', data: { reference: payment.reference, status: 'success', amount: shipment.quotedPriceKobo, currency: 'NGN' } },
    });
    const escrow = await request(`/v1/shipments/${shipment.id}/escrow`, { token: token('CUSTOMER') });
    // Unsigned events are acknowledged and audit-logged (Paystack expects a 2xx), but must
    // be marked unverified and change nothing.
    const refused = !forged.ok || (forged.payload?.verified === false && forged.payload?.escrowUpdated === false);
    return [refused && escrow.payload?.status === 'PENDING', `webhook ${forged.status} verified=${forged.payload?.verified}, escrow ${escrow.payload?.status}`];
  });
  await check('P4', 'customer cannot release, refund or tick release checks on an unpaid shipment', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const release = await request(`/v1/shipments/${shipment.id}/escrow/release`, { method: 'POST', token: token('CUSTOMER'), body: {} });
    const refund = await request(`/v1/shipments/${shipment.id}/escrow/refund`, { method: 'POST', token: token('CUSTOMER'), body: {} });
    const driverCheck = await request(`/v1/shipments/${shipment.id}/escrow/checks/proofOfDeliveryUploaded`, { method: 'POST', token: token('DRIVER') });
    return [denied(release.status) && denied(refund.status) && !driverCheck.ok, `release ${release.status}, refund ${refund.status}, driver check ${driverCheck.status}`];
  });

  // --- Tracking -------------------------------------------------------------------
  await check('T1', 'an unassigned driver cannot send GPS for the shipment', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const result = await request(`/v1/tracking/shipments/${shipment.id}/location`, {
      method: 'POST', token: token('DRIVER'), body: { latitude: PICKUP.latitude, longitude: PICKUP.longitude, capturedAt: new Date().toISOString() },
    });
    return [denied(result.status), message(result)];
  });
  await check('T2', 'an unassigned driver cannot read the shipment GPS trail', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const result = await request(`/v1/tracking/shipments/${shipment.id}/history`, { token: token('DRIVER') });
    return [denied(result.status), message(result)];
  });
  await check('T3', 'customer gets the planned road route (Google) for the map', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const first = await request(`/v1/tracking/shipments/${shipment.id}/planned-route`, { token: token('CUSTOMER') });
    const second = await request(`/v1/tracking/shipments/${shipment.id}/planned-route`, { token: token('CUSTOMER') });
    const line = first.payload?.encodedPolyline;
    return [first.ok && typeof line === 'string' && line.length > 20 && second.payload?.encodedPolyline === line, `${first.status}, ${line ? `${line.length} chars, stored and reused` : 'no route'}`];
  });
  await check('T4', 'the planned route is refused to an unassigned driver', async () => {
    if (!shipment?.id) return [null, 'no booking'];
    const result = await request(`/v1/tracking/shipments/${shipment.id}/planned-route`, { token: token('DRIVER') });
    return [denied(result.status), message(result)];
  });

  // --- Messaging --------------------------------------------------------------------
  await check('C1', 'a customer cannot open or create a conversation from a made-up id', async () => {
    const result = await request(`/v1/conversations/acceptance-unused-${Date.now()}/messages`, { token: token('CUSTOMER') });
    return [result.status === 404 || denied(result.status), message(result)];
  });

  // --- Notifications, legal --------------------------------------------------------
  for (const role of Object.keys(ACCOUNTS)) {
    await check('N1', `${role.toLowerCase()} can open their notification inbox`, async () => {
      if (!token(role)) return [null, 'not signed in'];
      const result = await request('/v1/notifications', { token: token(role) });
      const items = Array.isArray(result.payload) ? result.payload : result.payload?.items ?? result.payload?.notifications;
      return [result.ok && Array.isArray(items), `${result.status}, ${items?.length ?? 0} items`];
    });
  }
  for (const page of ['privacy', 'terms', 'account-deletion']) {
    await check('L1', `public ${page} page is served`, async () => {
      const result = await request(`/v1/legal/${page}`);
      return [result.ok, `${result.status}`];
    });
  }

  const failed = results.filter((item) => item.status === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} passed or skipped, ${failed.length} failed.`);
  if (shipment?.id) console.log(`Demo booking left unpaid for the funded-journey check: ${shipment.reference ?? ''} (${shipment.id})`);
  const jsonIndex = process.argv.indexOf('--json');
  if (jsonIndex > 0 && process.argv[jsonIndex + 1]) {
    fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify({ api: API_BASE_URL, checkedAt: new Date().toISOString(), paymentEnvironment, shipment: shipment && { id: shipment.id, reference: shipment.reference }, results }, null, 2));
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nAcceptance run stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
