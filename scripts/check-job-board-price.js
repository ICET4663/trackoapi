// Live check of driver price offers on the job board (owner rule, 25 November 2026). No payment:
//
//   1. the demo customer books a Lagos load (not paid)
//   2. the demo driver sees price terms for it, an offer outside the range is refused, and an
//      offer inside it is taken, priced as the driver's pay plus Trako's commission
//   3. the customer sees the offer, accepts it, and the shipment price changes to match
//   4. the customer declines that driver, and the shipment price goes back to the quote
//   5. the customer cancels the booking (nothing was paid, nothing is refunded)
//
// Demo accounts only; it refuses to run unless the API reports test payments.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/check-job-board-price.js

const { assertTestPayments } = require('./lib/test-payments-guard');

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const DEFAULT_PASSWORD = process.env.SIM_PASSWORD || 'password123';
const PICKUP = { latitude: 6.6018, longitude: 3.3515 };
const DESTINATION = { latitude: 6.4281, longitude: 3.4219 };
const DRIVER_PHONE_POSITION = { latitude: 6.5905, longitude: 3.3440 };

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

async function expectOk(urlPath, options) {
  const result = await request(urlPath, options);
  if (!result.ok) throw new Error(`${options?.method || 'GET'} ${urlPath} failed (${result.status}): ${messageOf(result)}`);
  return result.payload;
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SIM_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SIM_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const session = await expectOk('/v1/auth/login', { method: 'POST', body: { identifier, password, role } });
  if (!session.accessToken) throw new Error(`${role} login did not return an access token.`);
  return session;
}

const naira = (kobo) => `N${Math.round(Number(kobo) / 100).toLocaleString('en-US')}`;

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
      cargoType: 'Job board price check (demo)',
      quantity: '20 cartons',
      weightTons: 2,
      truckType: 'Box truck',
      pickupContactPhone: '+2348035550144',
      quoteToken: quote.quoteToken,
      clientRequestId: `job-board-price-${Date.now()}`,
    },
  });
}

async function main() {
  console.log(`Job board price offers: ${API_BASE_URL}\n`);
  const [customer, admin, driver] = await Promise.all([
    login('CUSTOMER', 'customer@tracko.ng'),
    login('ADMIN', 'admin@tracko.ng'),
    login('DRIVER', 'driver@tracko.ng'),
  ]);
  const environment = assertTestPayments(await expectOk('/v1/integrations/status', { accessToken: admin.accessToken }));
  check('payments are in test mode', true, environment);

  const board0 = await expectOk(`/v1/job-board?lat=${DRIVER_PHONE_POSITION.latitude}&lng=${DRIVER_PHONE_POSITION.longitude}`, { accessToken: driver.accessToken });
  if (board0.state !== 'OPEN') throw new Error(`The demo driver's board is ${board0.state}${board0.activeTrip ? ` (${board0.activeTrip})` : ''}.`);

  const shipment = await book(customer);
  const shipmentId = shipment.id;
  const quoted = Number(shipment.quotedPriceKobo);
  console.log(`  Booked ${shipment.reference ?? shipmentId} (${shipmentId}), quote ${naira(quoted)}, status ${shipment.status}`);

  let failure = null;
  try {
    const board = await expectOk(`/v1/job-board?lat=${DRIVER_PHONE_POSITION.latitude}&lng=${DRIVER_PHONE_POSITION.longitude}`, { accessToken: driver.accessToken });
    const load = (board.loads ?? []).find((item) => item.shipmentDbId === shipmentId);
    if (!check('the unpaid load is on the driver\'s board', Boolean(load) && load.boardStatus === 'AWAITING_PAYMENT', load?.boardStatus)) {
      throw new Error('Load not on the board.');
    }
    const terms = load.priceProposal;
    if (!check('it carries price terms', Boolean(terms), terms ? `trip pay ${naira(terms.quotedCarrierKobo)}, range ${naira(terms.minCarrierKobo)}-${naira(terms.maxCarrierKobo)}, running cost ${naira(terms.runningCostKobo)}` : 'none')) {
      throw new Error('No price terms (range setting 0, or a quote without a breakdown).');
    }
    check('the floor is never below the running cost', terms.minCarrierKobo >= terms.runningCostKobo);

    const tooLow = await request(`/v1/job-board/${shipmentId}/request`, {
      method: 'POST', accessToken: driver.accessToken, body: { ...DRIVER_PHONE_POSITION, proposedCarrierKobo: terms.minCarrierKobo - 100_000 },
    });
    check('an offer below the range is refused', tooLow.status === 400, `${tooLow.status} ${messageOf(tooLow)}`);

    const offer = Math.min(terms.maxCarrierKobo, Math.round((terms.quotedCarrierKobo * 1.1) / 100) * 100);
    const expectedPrice = offer + Math.round((offer / 100) * terms.commissionRate) * 100;
    await expectOk(`/v1/job-board/${shipmentId}/request`, {
      method: 'POST', accessToken: driver.accessToken, body: { ...DRIVER_PHONE_POSITION, proposedCarrierKobo: offer },
    });
    const board2 = await expectOk(`/v1/job-board?lat=${DRIVER_PHONE_POSITION.latitude}&lng=${DRIVER_PHONE_POSITION.longitude}`, { accessToken: driver.accessToken });
    const mine = (board2.loads ?? []).find((item) => item.shipmentDbId === shipmentId);
    check('the driver\'s offer is taken and priced as pay + commission', mine?.requested && mine.proposedCarrierKobo === offer && mine.proposedPriceKobo === expectedPrice,
      `pay ${naira(mine?.proposedCarrierKobo)}, customer ${naira(mine?.proposedPriceKobo)}, expected ${naira(expectedPrice)}`);

    const listed = await expectOk(`/v1/job-board/shipments/${shipmentId}/requests`, { accessToken: customer.accessToken });
    const ask = (listed.requests ?? []).find((item) => item.proposedPriceKobo === expectedPrice);
    check('the customer sees the offer next to the quote', Boolean(ask) && listed.quotedPriceKobo === quoted,
      `${listed.requests?.length ?? 0} request(s), quote ${naira(listed.quotedPriceKobo)}`);
    if (!ask) throw new Error('Offer not in the customer\'s list.');

    const byDriver = await request(`/v1/job-board/requests/${ask.id}/accept-price`, { method: 'POST', accessToken: driver.accessToken });
    check('a driver cannot accept a price', byDriver.status === 401 || byDriver.status === 403, String(byDriver.status));

    const accepted = await expectOk(`/v1/job-board/requests/${ask.id}/accept-price`, { method: 'POST', accessToken: customer.accessToken });
    check('the customer accepts the price', accepted.status === 'PRICE_ACCEPTED' && accepted.quotedPriceKobo === expectedPrice, naira(accepted.quotedPriceKobo));
    const afterAccept = await expectOk(`/v1/shipments/${shipmentId}`, { accessToken: customer.accessToken });
    check('the shipment price changes to the accepted price', Number(afterAccept.quotedPriceKobo) === expectedPrice, naira(afterAccept.quotedPriceKobo));
    const board3 = await expectOk(`/v1/job-board?lat=${DRIVER_PHONE_POSITION.latitude}&lng=${DRIVER_PHONE_POSITION.longitude}`, { accessToken: driver.accessToken });
    check('the driver sees the price accepted', (board3.loads ?? []).some((item) => item.shipmentDbId === shipmentId && item.priceAccepted === true));

    await expectOk(`/v1/job-board/requests/${ask.id}/decline`, { method: 'POST', accessToken: customer.accessToken });
    const afterDecline = await expectOk(`/v1/shipments/${shipmentId}`, { accessToken: customer.accessToken });
    check('declining that driver puts the quote back', Number(afterDecline.quotedPriceKobo) === quoted, naira(afterDecline.quotedPriceKobo));
  } catch (error) {
    failure = error;
  } finally {
    const cancel = await request(`/v1/shipments/${shipmentId}/status`, {
      method: 'PATCH', accessToken: customer.accessToken, body: { status: 'CANCELLED', note: 'Job board price check cleanup (demo).' },
    });
    check('the demo booking is cancelled', cancel.ok && cancel.payload?.status === 'CANCELLED', String(cancel.payload?.status ?? cancel.status));
  }
  if (failure) throw failure;

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nStopped: ${error.message}`);
  process.exit(1);
});
