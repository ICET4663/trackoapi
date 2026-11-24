// A complete trip through the job board, the way a real customer and driver use it:
//
//   1. the customer books a Lagos load (not paid yet)
//   2. the driver, standing near the pickup, sees it on the job board tagged AWAITING_PAYMENT,
//      measured from the phone's position, and asks for it
//   3. nobody can give the unpaid load to a driver: the customer's choice and a dispatch
//      assignment are both refused
//   4. the customer pays in Paystack TEST mode (you pay in your browser with a test card;
//      the checkout has a human check, so it cannot be scripted) and the script waits
//   5. an admin approves the paid load, the customer chooses the driver who asked
//   6. the existing scripts drive it: simulate-trip.js (live GPS along the route) and
//      check-customer-journey.js (every status step, proof of delivery, confirmation, release)
//
// It refuses to run unless the API reports test payments. It creates and completes one demo
// shipment for the demo customer and driver, so only run it with demo accounts.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/simulate-job-board-trip.js
//   SIM_SHIPMENT_ID=<id> ...   resume with a shipment this script booked earlier
//   SIM_PAY_WAIT_MINUTES=20    how long to wait for the test payment (default 15)
//   SIM_SKIP_DRIVE=1           stop once the driver has the load

const { spawnSync } = require('child_process');
const path = require('path');
const { assertTestPayments } = require('./lib/test-payments-guard');

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const DEFAULT_PASSWORD = process.env.SIM_PASSWORD || 'password123';
const PAY_WAIT_MS = Math.max(1, Number(process.env.SIM_PAY_WAIT_MINUTES) || 15) * 60 * 1000;
// Ikeja City Mall to Victoria Island; the driver waits about 1.5 km from the pickup.
const PICKUP = { latitude: 6.6018, longitude: 3.3515 };
const DESTINATION = { latitude: 6.4281, longitude: 3.4219 };
const DRIVER_PHONE_POSITION = { latitude: 6.5905, longitude: 3.3440 };
const FUNDED = ['FUNDED', 'HELD', 'RELEASE_READY'];

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

async function expectOk(urlPath, options) {
  const result = await request(urlPath, options);
  if (!result.ok) {
    throw new Error(`${options?.method || 'GET'} ${urlPath} failed (${result.status}): ${messageOf(result)}`);
  }
  return result.payload;
}

function messageOf(result) {
  const message = result.payload?.message;
  return Array.isArray(message) ? message.join('; ') : String(message ?? '');
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SIM_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SIM_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const session = await expectOk('/v1/auth/login', { method: 'POST', body: { identifier, password, role } });
  if (!session.accessToken) throw new Error(`${role} login did not return an access token.`);
  return session;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const boardPath = (position) => `/v1/job-board?lat=${position.latitude}&lng=${position.longitude}`;

async function boardEntry(driver, shipmentId) {
  const board = await expectOk(boardPath(DRIVER_PHONE_POSITION), { accessToken: driver.accessToken });
  return { board, load: (board.loads ?? []).find((item) => item.shipmentDbId === shipmentId) };
}

async function book(customer) {
  const quote = await expectOk('/v1/maps/route-estimate', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      originLatitude: PICKUP.latitude,
      originLongitude: PICKUP.longitude,
      destinationLatitude: DESTINATION.latitude,
      destinationLongitude: DESTINATION.longitude,
      truckType: 'Box truck',
      weightTons: 2,
    },
  });
  return expectOk('/v1/shipments', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      origin: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja, Lagos',
      destination: 'Adeola Odeku Street, Victoria Island, Lagos',
      originCoordinates: PICKUP,
      destinationCoordinates: DESTINATION,
      cargoType: 'Job board trip simulation (demo)',
      quantity: '20 cartons',
      weightTons: 2,
      truckType: 'Box truck',
      pickupContactPhone: '+2348035550144',
      quoteToken: quote.quoteToken,
      clientRequestId: `job-board-sim-${Date.now()}`,
    },
  });
}

async function waitForPayment(customer, shipmentId) {
  const escrow = await expectOk(`/v1/shipments/${shipmentId}/escrow`, { accessToken: customer.accessToken });
  if (FUNDED.includes(escrow.status)) return escrow.status;

  const checkout = await expectOk('/v1/payments/escrow/initialize', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: { shipmentId, amount: 1, method: 'card' },
  });
  const reference = checkout.providerReference;
  console.log('\n  Pay for the shipment in your browser (Paystack TEST mode, test card 4084 0840 8408 4081,');
  console.log('  any future expiry, CVV 408, PIN 0000, OTP 123456):');
  console.log(`\n  ${checkout.authorizationUrl}\n`);
  console.log(`  Waiting up to ${PAY_WAIT_MS / 60000} minutes for the payment...`);

  const deadline = Date.now() + PAY_WAIT_MS;
  while (Date.now() < deadline) {
    await wait(10_000);
    if (reference) {
      await request(`/v1/payments/paystack/verify/${encodeURIComponent(reference)}`, { accessToken: customer.accessToken });
    }
    const current = await expectOk(`/v1/shipments/${shipmentId}/escrow`, { accessToken: customer.accessToken });
    if (FUNDED.includes(current.status)) return current.status;
  }
  throw new Error(`No payment arrived in ${PAY_WAIT_MS / 60000} minutes. Rerun with SIM_SHIPMENT_ID=${shipmentId} after paying.`);
}

function runScript(file, env) {
  console.log(`\n--- ${file} ---`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    env: { ...process.env, API_BASE_URL, ...env },
  });
  return check(`${file} passed`, result.status === 0, `exit ${result.status}`);
}

async function main() {
  console.log(`Job board trip simulation: ${API_BASE_URL}\n`);
  const [customer, admin, dispatcher, driver] = await Promise.all([
    login('CUSTOMER', 'customer@tracko.ng'),
    login('ADMIN', 'admin@tracko.ng'),
    login('DISPATCHER', 'dispatcher@tracko.ng'),
    login('DRIVER', 'driver@tracko.ng'),
  ]);
  check('customer, admin, dispatcher and driver can log in', true);
  const environment = assertTestPayments(await expectOk('/v1/integrations/status', { accessToken: admin.accessToken }));
  check('payments are in test mode, so no real money moves', true, environment);

  const opening = await expectOk(boardPath(DRIVER_PHONE_POSITION), { accessToken: driver.accessToken });
  if (opening.state === 'ON_TRIP') {
    throw new Error(`The demo driver is still on ${opening.activeTrip}. Finish or release that trip first.`);
  }
  check('the driver\'s job board is open', ['OPEN', 'OFFLINE'].includes(opening.state), opening.state);
  if (opening.state === 'OFFLINE') throw new Error('The demo driver is offline. Turn "available for loads" on in the driver app.');

  // 1. Booked, not paid.
  console.log('\nBooked, not paid');
  let shipment = process.env.SIM_SHIPMENT_ID
    ? await expectOk(`/v1/shipments/${encodeURIComponent(process.env.SIM_SHIPMENT_ID.trim())}`, { accessToken: customer.accessToken })
    : await book(customer);
  const shipmentId = shipment.id;
  console.log(`  Shipment ${shipment.reference ?? shipmentId} (${shipmentId}), status ${shipment.status}`);
  const unpaidAtStart = ['DRAFT', 'QUOTED', 'PENDING_PAYMENT'].includes(shipment.status);
  if (!unpaidAtStart) console.log('SKIP  the unpaid steps: this shipment is already paid');

  // 2. The driver sees it near them and asks for it.
  console.log('\nDriver near the pickup');
  let { board, load } = await boardEntry(driver, shipmentId);
  check('the board measures distance from the phone position it was sent', board.position?.latitude === DRIVER_PHONE_POSITION.latitude);
  check('the driver sees the load on the job board', Boolean(load), load ? `${load.shipmentId}, ${load.pickupKm} km to pickup` : `${board.loads?.length ?? 0} other loads`);
  if (!load) throw new Error('The load is not on the driver\'s board (truck too small, sandbox account mix, or already taken).');
  if (unpaidAtStart) {
    check('it is tagged as awaiting payment', load.boardStatus === 'AWAITING_PAYMENT' && load.paid === false, load.boardStatus);
  }
  check('the pickup distance is from the phone (under 5 km)', typeof load.pickupKm === 'number' && load.pickupKm < 5, `${load.pickupKm} km`);
  check('the pickup has map coordinates for the board map', Boolean(load.originCoordinates));
  if (!load.requested) {
    const asked = await expectOk(`/v1/job-board/${shipmentId}/request`, {
      method: 'POST', accessToken: driver.accessToken, body: DRIVER_PHONE_POSITION,
    });
    check('the driver asks for the load', asked.status === 'PENDING');
  } else {
    check('the driver had already asked for the load', true);
  }

  let requests = await expectOk(`/v1/job-board/shipments/${shipmentId}/requests`, { accessToken: customer.accessToken });
  const ask = (requests.requests ?? [])[0];
  check('the customer sees the driver who asked', Boolean(ask), ask ? `${ask.driverName}, ${ask.pickupKm ?? '?'} km from pickup` : 'none');
  if (!ask) throw new Error('The customer cannot see the driver request.');
  check('the customer sees the distance from where the driver asked (under 5 km)',
    typeof ask.pickupKm === 'number' && ask.pickupKm < 5, `${ask.pickupKm} km`);

  // 3. Nobody gets an unpaid load.
  if (unpaidAtStart) {
    console.log('\nNo truck moves before payment');
    const early = await request(`/v1/job-board/requests/${ask.id}/approve`, { method: 'POST', accessToken: customer.accessToken });
    check('the customer cannot choose a driver before paying', early.status === 400 && /Pay for this shipment first/.test(messageOf(early)), `${early.status} ${messageOf(early)}`);
    const driverId = driver.user?.id;
    if (driverId) {
      const dispatch = await request(`/v1/shipments/${shipmentId}/assignments`, {
        method: 'POST',
        accessToken: dispatcher.accessToken,
        body: { driverId },
      });
      check('dispatch cannot assign an unpaid load', !dispatch.ok, `${dispatch.status} ${messageOf(dispatch)}`);
    }
  }

  // 4. Paid.
  console.log('\nPayment');
  const escrowStatus = await waitForPayment(customer, shipmentId);
  check('the payment is held', FUNDED.includes(escrowStatus), escrowStatus);
  shipment = await expectOk(`/v1/shipments/${shipmentId}`, { accessToken: customer.accessToken });

  // 5. Approved, then the customer chooses.
  console.log('\nApproval and choice');
  if (!shipment.adminApproved) {
    ({ load } = await boardEntry(driver, shipmentId));
    check('while Trako checks it, the board shows it as paid and being checked', load?.boardStatus === 'AWAITING_APPROVAL', load?.boardStatus);
    const early = await request(`/v1/job-board/requests/${ask.id}/approve`, { method: 'POST', accessToken: customer.accessToken });
    check('the customer cannot choose before the Trako check', early.status === 400, messageOf(early));
    const approved = await expectOk(`/v1/shipments/${shipmentId}/approve`, { method: 'POST', accessToken: admin.accessToken });
    check('admin approves the paid load', approved.adminApproved === true);
  }
  ({ load } = await boardEntry(driver, shipmentId));
  check('the board now shows it ready', load?.boardStatus === 'READY', load?.boardStatus);
  requests = await expectOk(`/v1/job-board/shipments/${shipmentId}/requests`, { accessToken: customer.accessToken });
  check('the customer sees the load as ready to choose', requests.boardStatus === 'READY', requests.boardStatus);
  const chosen = await expectOk(`/v1/job-board/requests/${ask.id}/approve`, { method: 'POST', accessToken: customer.accessToken });
  check('the customer chooses the driver', chosen.status === 'APPROVED', chosen.assignmentId);
  shipment = await expectOk(`/v1/shipments/${shipmentId}`, { accessToken: customer.accessToken });
  check('the driver is on the way to the pickup', shipment.status === 'DRIVER_EN_ROUTE', shipment.status);
  board = await expectOk(boardPath(DRIVER_PHONE_POSITION), { accessToken: driver.accessToken });
  check('the driver\'s board closes while on the trip', board.state === 'ON_TRIP', board.state);

  // 6. The trip itself.
  if (process.env.SIM_SKIP_DRIVE) {
    console.log(`\nSIM_SKIP_DRIVE set: stopping. Drive it later with SIM_SHIPMENT_ID=${shipmentId}.`);
  } else {
    runScript('simulate-trip.js', { SIM_SHIPMENT_ID: shipmentId, SIM_STEPS: process.env.SIM_STEPS || '8', SIM_INTERVAL_SECONDS: process.env.SIM_INTERVAL_SECONDS || '2' });
    runScript('check-customer-journey.js', { SIM_SHIPMENT_ID: shipmentId });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Shipment ${shipment.reference ?? shipmentId} (${shipmentId}).`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nSTOPPED: ${error.message}`);
  const failed = results.filter((item) => !item.ok);
  console.log(`${results.length - failed.length}/${results.length} passed before stopping.`);
  process.exitCode = 1;
});
