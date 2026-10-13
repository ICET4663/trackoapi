// Takes one paid shipment from driver assignment to completion and checks, at every
// step, what the CUSTOMER sees: the addresses they booked, the current status, the
// timeline, and the live truck position while the driver is on the road. Finally checks
// that GPS sharing stops once the trip is over and the trail stays viewable.
//
// It needs a shipment whose escrow is already FUNDED (a Paystack test checkout cannot
// be scripted). It completes that shipment and releases its escrow, so only point it at
// demo/test shipments.
//
//   SIM_SHIPMENT_ID=<funded shipment id> npm run check:journey

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const SHIPMENT_ID = process.env.SIM_SHIPMENT_ID?.trim();
const DEFAULT_PASSWORD = process.env.SIM_PASSWORD || 'password123';
const LIVE_STEPS = ['DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION'];

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
  return { ...session, email: identifier };
}

const shipmentPath = (suffix = '') => `/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}${suffix}`;
const trackingPath = (suffix = '') => `/v1/tracking/shipments/${encodeURIComponent(SHIPMENT_ID)}${suffix}`;

function pointAt(shipment, fraction) {
  const from = shipment.originCoordinates;
  const to = shipment.destinationCoordinates;
  return {
    latitude: Number((from.latitude + (to.latitude - from.latitude) * fraction).toFixed(6)),
    longitude: Number((from.longitude + (to.longitude - from.longitude) * fraction).toFixed(6)),
  };
}

// What the customer's app is given for this shipment right now.
async function customerView(customer) {
  const shipment = await expectOk(shipmentPath(), { accessToken: customer.accessToken });
  const location = await request(trackingPath(), { accessToken: customer.accessToken });
  // The API answers 200 with an empty body when no position has been reported yet.
  return { shipment, location: location.ok && location.payload?.id ? location.payload : null, locationStatus: location.status };
}

async function main() {
  if (!SHIPMENT_ID) throw new Error('Set SIM_SHIPMENT_ID to a shipment whose escrow is FUNDED.');
  console.log(`Tracko customer journey check: ${API_BASE_URL}`);
  console.log(`Shipment: ${SHIPMENT_ID}\n`);

  const [customer, admin, dispatcher, driver] = await Promise.all([
    login('CUSTOMER', 'customer@tracko.ng'),
    login('ADMIN', 'admin@tracko.ng'),
    login('DISPATCHER', 'dispatcher@tracko.ng'),
    login('DRIVER', 'driver@tracko.ng'),
  ]);
  check('customer, admin, dispatcher and driver can log in', true);

  // 1. Booked and paid, no driver yet.
  console.log('\nBooked and paid');
  let view = await customerView(customer);
  const booked = view.shipment;
  check('customer sees the pickup and destination they booked', Boolean(booked.origin && booked.destination), `${booked.origin} -> ${booked.destination}`);
  const hasCoordinates = Number.isFinite(booked.originCoordinates?.latitude) && Number.isFinite(booked.destinationCoordinates?.latitude);
  check('booking keeps the map coordinates of both addresses', hasCoordinates);
  if (!hasCoordinates) throw new Error('The shipment has no map coordinates to drive between.');
  const escrow = await expectOk(shipmentPath('/escrow'), { accessToken: customer.accessToken });
  check('customer sees the payment held in escrow', ['FUNDED', 'HELD'].includes(escrow.status), `escrow ${escrow.status}`);
  if (!['FUNDED', 'HELD'].includes(escrow.status)) throw new Error('This shipment is not paid; pick a FUNDED one.');
  if (LIVE_STEPS.includes(booked.status)) {
    console.log(`SKIP  pre-trip checks: the trip is already ${booked.status}; continuing from there`);
  } else {
    check('no truck position is shown before a driver starts', view.location === null, `tracking ${view.locationStatus}`);
  }

  // 2. Driver assigned.
  console.log('\nDriver assigned');
  let assignments = await expectOk(shipmentPath('/assignments'), { accessToken: dispatcher.accessToken });
  let assignment = assignments.find((item) => ['OFFERED', 'ACCEPTED'].includes(item.status));
  if (!assignment) {
    const drivers = await expectOk('/v1/shipments/dispatch/available-drivers', { accessToken: dispatcher.accessToken });
    const match = (Array.isArray(drivers) ? drivers : drivers.drivers ?? []).find((item) => item.email === driver.email || item.user?.email === driver.email);
    if (!match) throw new Error(`${driver.email} is not in the available-driver list.`);
    assignment = await expectOk(shipmentPath('/assignments'), {
      method: 'POST',
      accessToken: dispatcher.accessToken,
      body: { driverId: match.id ?? match.userId ?? match.user?.id },
    });
  }
  if (assignment.status === 'OFFERED') {
    assignment = await expectOk(`/v1/shipments/assignments/${encodeURIComponent(assignment.id)}/accept`, {
      method: 'POST',
      accessToken: driver.accessToken,
    });
  }
  check('driver accepted the job', assignment.status === 'ACCEPTED', assignment.status);
  view = await customerView(customer);
  check('customer sees that a driver is on the job', ['DRIVER_ASSIGNED', ...LIVE_STEPS].includes(view.shipment.status), view.shipment.status);

  // 3. On the road: each status change, with a GPS fix, reaches the customer.
  console.log('\nOn the road');
  let pingsSent = 0;
  let index = LIVE_STEPS.indexOf(view.shipment.status);
  for (index = Math.max(index + 1, 0); index < LIVE_STEPS.length; index += 1) {
    const status = LIVE_STEPS[index];
    // Pickup steps sit at the pickup; the trip then moves toward the destination.
    const fraction = index <= 2 ? 0 : index === 3 ? 0.5 : 1;
    await expectOk(shipmentPath('/status'), {
      method: 'PATCH',
      accessToken: driver.accessToken,
      body: { status, note: `Journey check: ${status.toLowerCase().replace(/_/g, ' ')}.` },
    });
    const point = pointAt(booked, fraction);
    const ping = await request(trackingPath('/location'), {
      method: 'POST',
      accessToken: driver.accessToken,
      body: { ...point, speedKph: fraction > 0 && fraction < 1 ? 60 : 0, accuracyM: 10, recordedAt: new Date().toISOString(), clientPingId: `journey-${Date.now()}-${status}` },
    });
    if (ping.ok) pingsSent += 1;
    view = await customerView(customer);
    check(
      `${status}: customer sees the status and the truck where the driver is`,
      ping.ok && view.shipment.status === status && view.location?.id === ping.payload.id,
      `status ${view.shipment.status}, truck ${view.location ? `${view.location.latitude}, ${view.location.longitude}` : 'none'}`,
    );
  }
  const timeline = view.shipment.timeline ?? [];
  check('customer timeline records every step of the trip', LIVE_STEPS.every((status) => timeline.some((entry) => JSON.stringify(entry).includes(status))), `${timeline.length} entries`);

  // 4. Delivered and completed.
  console.log('\nDelivered and completed');
  await expectOk(shipmentPath('/escrow/checks/arrivalConfirmed'), { method: 'POST', accessToken: driver.accessToken });
  const proofs = await expectOk(trackingPath('/proof-of-delivery'), { accessToken: driver.accessToken });
  if (!Array.isArray(proofs) || proofs.length === 0) {
    await expectOk(trackingPath('/proof-of-delivery'), {
      method: 'POST',
      accessToken: driver.accessToken,
      body: { recipientName: 'Tracko Journey Check Receiver', note: 'Delivered during the customer journey check.' },
    });
  }
  const customerProofs = await expectOk(trackingPath('/proof-of-delivery'), { accessToken: customer.accessToken });
  check('customer can see the proof of delivery', Array.isArray(customerProofs) && customerProofs.length > 0, `${customerProofs.length ?? 0} proof(s)`);

  for (const releaseCheck of ['customerDeliveryConfirmed', 'disputeWindowClear']) {
    await expectOk(shipmentPath(`/escrow/checks/${releaseCheck}`), { method: 'POST', accessToken: customer.accessToken });
  }
  await expectOk(shipmentPath('/escrow/checks/platformApproved'), { method: 'POST', accessToken: admin.accessToken });
  let released = await expectOk(shipmentPath('/escrow'), { accessToken: admin.accessToken });
  if (released.status === 'RELEASE_READY') {
    released = await expectOk(shipmentPath('/escrow/release'), {
      method: 'POST',
      accessToken: admin.accessToken,
      body: { note: 'Customer journey check: delivery confirmed.' },
    });
  }
  check('payment is released to the driver after the customer confirms', released.status === 'RELEASED', `escrow ${released.status}`);

  view = await customerView(customer);
  check('customer sees the shipment as completed', view.shipment.status === 'COMPLETED', view.shipment.status);

  // 5. After the trip.
  console.log('\nAfter the trip');
  const lateping = await request(trackingPath('/location'), {
    method: 'POST',
    accessToken: driver.accessToken,
    body: { ...pointAt(booked, 1), recordedAt: new Date().toISOString() },
  });
  check('driver GPS sharing stops once the trip is over', lateping.status === 409, `${lateping.status}`);
  const history = await expectOk(trackingPath('/history'), { accessToken: customer.accessToken });
  check('customer can still review the route the truck took', Array.isArray(history) && history.length >= pingsSent, `${history.length} points, ${pingsSent} sent on this run`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAIL  ${error.message}`);
  process.exit(1);
});
