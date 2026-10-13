// Drives a simulated driver along a shipment's route and checks, after every GPS ping,
// that the customer sees the same position. Then checks the offline-queue rules:
// a late, older fix must not replace a newer one, a retried ping must not duplicate,
// and only the assigned driver may report. Use it to demo live tracking: open the
// customer's tracking screen (web or phone) and watch the truck move while it runs.
//
// It only adds GPS pings. It never changes the shipment status, escrow or payments.
//
//   SIM_SHIPMENT_ID=<shipment id> npm run simulate:trip
//   SIM_SHIPMENT_ID=<shipment id> SIM_STEPS=20 SIM_INTERVAL_SECONDS=4 npm run simulate:trip
//
// The shipment must be in a live status (DRIVER_EN_ROUTE ... ARRIVED_DESTINATION) with
// the driver's assignment ACCEPTED.

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const SHIPMENT_ID = process.env.SIM_SHIPMENT_ID?.trim();
const STEPS = Math.max(2, Number(process.env.SIM_STEPS) || 12);
const INTERVAL_MS = Math.max(1, Number(process.env.SIM_INTERVAL_SECONDS) || 5) * 1000;
const DEFAULT_PASSWORD = process.env.SIM_PASSWORD || 'password123';
// Lagos: Ikeja to Victoria Island, used when the shipment has no stored coordinates.
const FALLBACK_ROUTE = { from: [6.6018, 3.3515], to: [6.4281, 3.4219] };

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
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

async function expectOk(path, options) {
  const result = await request(path, options);
  if (!result.ok) {
    throw new Error(`${options?.method || 'GET'} ${path} failed (${result.status}): ${result.payload.message || ''}`);
  }
  return result.payload;
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SIM_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SIM_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const session = await expectOk('/v1/auth/login', { method: 'POST', body: { identifier, password, role } });
  if (!session.accessToken) throw new Error(`${role} login did not return an access token.`);
  return session;
}

function routeFor(shipment) {
  const from = [shipment.originCoordinates?.latitude, shipment.originCoordinates?.longitude];
  const to = [shipment.destinationCoordinates?.latitude, shipment.destinationCoordinates?.longitude];
  const valid = [...from, ...to].every((value) => typeof value === 'number' && Number.isFinite(value));
  return valid
    ? { from, to, source: `${shipment.origin} -> ${shipment.destination}` }
    : { ...FALLBACK_ROUTE, source: 'fallback Lagos route' };
}

function pointAt(route, fraction) {
  return {
    latitude: Number((route.from[0] + (route.to[0] - route.from[0]) * fraction).toFixed(6)),
    longitude: Number((route.from[1] + (route.to[1] - route.from[1]) * fraction).toFixed(6)),
  };
}

function headingOf(route) {
  const radians = Math.atan2(route.to[1] - route.from[1], route.to[0] - route.from[0]);
  return Math.round(((radians * 180) / Math.PI + 360) % 360);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pingId = (label) => `sim-${Date.now().toString(36)}-${label}`;
const samePosition = (a, b) => Math.abs(a.latitude - b.latitude) < 1e-6 && Math.abs(a.longitude - b.longitude) < 1e-6;

async function ping(driver, shipmentId, point, extra = {}) {
  return request(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/location`, {
    method: 'POST',
    accessToken: driver.accessToken,
    body: { ...point, speedKph: 42, accuracyM: 8, recordedAt: new Date().toISOString(), clientPingId: pingId('live'), ...extra },
  });
}

async function main() {
  if (!SHIPMENT_ID) throw new Error('Set SIM_SHIPMENT_ID to a shipment that is on the road (DRIVER_EN_ROUTE to ARRIVED_DESTINATION) with the demo driver assigned.');
  console.log(`Tracko trip simulator: ${API_BASE_URL}`);
  console.log(`Shipment: ${SHIPMENT_ID}\n`);

  const [customer, driver] = await Promise.all([
    login('CUSTOMER', 'customer@tracko.ng'),
    login('DRIVER', 'driver@tracko.ng'),
  ]);
  check('customer and driver can log in', true);

  const shipment = await expectOk(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}`, { accessToken: customer.accessToken });
  const shipmentId = shipment.id || SHIPMENT_ID;
  const route = routeFor(shipment);
  const heading = headingOf(route);
  console.log(`Status: ${shipment.status}. Route: ${route.source}.`);
  console.log("Open this shipment's tracking screen as the customer now to watch the truck move.\n");

  // 1. Live trip: every ping must be what the customer sees next.
  // Leave the last 20% of the route for the offline-queue check below.
  let lastLive;
  for (let step = 0; step < STEPS; step += 1) {
    const point = pointAt(route, (step / (STEPS - 1)) * 0.8);
    const sent = await ping(driver, shipmentId, point, { heading });
    if (!sent.ok) {
      check(`ping ${step + 1}/${STEPS} accepted`, false, `${sent.status}: ${sent.payload.message}`);
      break;
    }
    const seen = await expectOk(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}`, { accessToken: customer.accessToken });
    const ageSeconds = seen ? Math.round((Date.now() - new Date(seen.createdAt).getTime()) / 1000) : null;
    check(
      `ping ${step + 1}/${STEPS} reaches the customer`,
      Boolean(seen) && seen.id === sent.payload.id && samePosition(seen, point),
      `${point.latitude}, ${point.longitude}, ${ageSeconds}s old, accuracy ${seen?.accuracyM ?? '-'} m`,
    );
    lastLive = { ...point, id: sent.payload.id };
    if (step < STEPS - 1) await sleep(INTERVAL_MS);
  }
  if (!lastLive) throw new Error('No live ping was recorded; see the failures above.');

  // 2. Offline queue: the phone captured a fix 60 s ago while it had no signal, a newer
  // fix got through first, and the queued one arrives late.
  console.log('\nOffline-queue checks');
  const newest = pointAt(route, 0.9);
  const newer = await ping(driver, shipmentId, newest, { heading, clientPingId: pingId('newest') });
  check('newer fix after reconnect is accepted', newer.ok, `${newer.status}`);

  const queuedAt = new Date(Date.now() - 60_000).toISOString();
  const queuedPoint = pointAt(route, 0.85);
  const queuedId = pingId('queued');
  const late = await ping(driver, shipmentId, queuedPoint, { heading, recordedAt: queuedAt, clientPingId: queuedId });
  check('late queued fix is accepted', late.ok, `${late.status}`);
  check('late fix keeps its capture time, not its arrival time', late.payload.createdAt === queuedAt, `${late.payload.createdAt}`);

  const current = await expectOk(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}`, { accessToken: customer.accessToken });
  check('late older fix does not move the truck backwards', current?.id === newer.payload.id && samePosition(current, newest));

  const historyBefore = await expectOk(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/history`, { accessToken: customer.accessToken });
  const retry = await ping(driver, shipmentId, queuedPoint, { heading, recordedAt: queuedAt, clientPingId: queuedId });
  const historyAfter = await expectOk(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/history`, { accessToken: customer.accessToken });
  check(
    'retried ping (same id) is not stored twice',
    retry.ok && retry.payload.id === late.payload.id && historyAfter.length === historyBefore.length,
    `history ${historyBefore.length} -> ${historyAfter.length}`,
  );
  check('late fix appears in the trail history', historyAfter.some((row) => row.id === late.payload.id));

  // 3. Access rules.
  console.log('\nAccess checks');
  const asCustomer = await request(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}/location`, {
    method: 'POST',
    accessToken: customer.accessToken,
    body: { ...newest, recordedAt: new Date().toISOString() },
  });
  check('a customer cannot report a location', asCustomer.status === 401 || asCustomer.status === 403, `${asCustomer.status}`);
  const anonymous = await request(`/v1/tracking/shipments/${encodeURIComponent(shipmentId)}`);
  check('tracking cannot be read without logging in', anonymous.status === 401 || anonymous.status === 403, `${anonymous.status}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAIL  ${error.message}`);
  process.exit(1);
});
