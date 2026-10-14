// The exception paths of a paid shipment, checked against a deployed API with the demo
// accounts: a driver declining an offer, dispatch withdrawing an assignment and
// reassigning, repeated taps, trip rewinds, a customer dispute blocking release, and a
// refund that cannot be repeated or followed by a release. The happy path is
// `npm run check:journey`.
//
// It needs a shipment whose escrow is already FUNDED (pay it with a Paystack TEST card
// in the web app) and REFUNDS it, so only point it at demo shipments.
//
//   API_BASE_URL=https://trackoapi.vercel.app SIM_SHIPMENT_ID=<funded demo shipment id> node scripts/check-exceptions.js

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const SHIPMENT_ID = process.env.SIM_SHIPMENT_ID?.trim();
const PASSWORD = process.env.SIM_PASSWORD || 'password123';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
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
async function expectOk(path, options) {
  const result = await request(path, options);
  if (!result.ok) throw new Error(`${options?.method || 'GET'} ${path} failed (${result.status}): ${result.payload?.message || ''}`);
  return result.payload;
}
async function login(identifier, role) {
  return expectOk('/v1/auth/login', { method: 'POST', body: { identifier, password: PASSWORD, role } });
}

const shipmentPath = (suffix = '') => `/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}${suffix}`;
const trackingPath = (suffix = '') => `/v1/tracking/shipments/${encodeURIComponent(SHIPMENT_ID)}${suffix}`;
const denied = (status) => status === 401 || status === 403;

async function main() {
  if (!SHIPMENT_ID) throw new Error('Set SIM_SHIPMENT_ID to a demo shipment whose escrow is FUNDED.');
  console.log(`Trako exception paths against ${API_BASE_URL}, shipment ${SHIPMENT_ID}\n`);

  const customer = await login(process.env.SIM_CUSTOMER_EMAIL || 'customer@tracko.ng', 'CUSTOMER');
  const dispatcher = await login(process.env.SIM_DISPATCHER_EMAIL || 'dispatcher@tracko.ng', 'DISPATCHER');
  const admin = await login(process.env.SIM_ADMIN_EMAIL || 'admin@tracko.ng', 'ADMIN');
  const driverEmails = [process.env.SIM_DRIVER_EMAIL || 'driver@tracko.ng', process.env.SIM_DRIVER2_EMAIL || 'driver2@tracko.ng'];

  const escrow = await expectOk(shipmentPath('/escrow'), { token: customer.accessToken });
  if (!['FUNDED', 'HELD'].includes(escrow.status)) throw new Error(`Escrow is ${escrow.status}; pay the shipment with a Paystack test card first.`);
  const booked = await expectOk(shipmentPath(), { token: customer.accessToken });
  const point = booked.originCoordinates;

  await expectOk(shipmentPath('/approve'), { method: 'POST', token: admin.accessToken });

  // Which demo drivers can take the job right now.
  const listing = await expectOk('/v1/shipments/dispatch/available-drivers', { token: dispatcher.accessToken });
  const available = (Array.isArray(listing) ? listing : listing.drivers ?? []);
  const drivers = [];
  for (const email of driverEmails) {
    const match = available.find((item) => item.email === email || item.user?.email === email);
    if (match) drivers.push({ email, id: match.id ?? match.userId ?? match.user?.id, session: await login(email, 'DRIVER') });
  }
  if (!drivers.length) throw new Error('No demo driver is available (each must be free of unfinished trips).');
  const [first, second = drivers[0]] = drivers;
  console.log(`      drivers available: ${drivers.map((driver) => driver.email).join(', ')}\n`);

  const offer = (driver) => expectOk(shipmentPath('/assignments'), { method: 'POST', token: dispatcher.accessToken, body: { driverId: driver.id } });

  const shipmentStatus = async () => (await expectOk(shipmentPath(), { token: dispatcher.accessToken })).status;
  let assignments = await expectOk(shipmentPath('/assignments'), { token: dispatcher.accessToken });
  let current = assignments.find((item) => item.status === 'ACCEPTED');

  // X1: a declined offer gives the driver nothing, and a paid shipment stays paid.
  let declined = assignments.find((item) => item.status === 'REJECTED');
  if (!current) {
    declined = await offer(second);
    const reject = await request(`/v1/shipments/assignments/${declined.id}/reject`, { method: 'POST', token: second.session.accessToken });
    const afterReject = await request(trackingPath('/history'), { token: second.session.accessToken });
    const statusAfter = await shipmentStatus();
    check('X1', 'a driver who declines gets no access; the paid shipment stays paid', reject.ok && denied(afterReject.status) && statusAfter === 'ESCROW_FUNDED', `reject ${reject.payload?.status ?? reject.status}, trail ${afterReject.status}, shipment ${statusAfter}`);
    current = await offer(first);
    current = await expectOk(`/v1/shipments/assignments/${current.id}/accept`, { method: 'POST', token: first.session.accessToken });
  } else {
    console.log('      X1 skipped: a driver already accepted this shipment (decline was checked on an earlier run)');
  }
  const released = drivers.find((item) => item.id === current.driverId) ?? first;

  // X2: operations take the accepted driver off the job before pickup.
  const cancel = await request(`/v1/shipments/assignments/${current.id}/cancel`, { method: 'POST', token: dispatcher.accessToken });
  const staleGps = await request(trackingPath('/location'), { method: 'POST', token: released.session.accessToken, body: { ...point, recordedAt: new Date().toISOString() } });
  const afterRelease = await shipmentStatus();
  check('X2', 'operations take an accepted driver off before pickup; their GPS is refused; payment stays held', cancel.ok && denied(staleGps.status) && afterRelease === 'ESCROW_FUNDED', `cancel ${cancel.status}, GPS ${staleGps.status}, shipment ${afterRelease}`);
  const lateAccept = await request(`/v1/shipments/assignments/${current.id}/accept`, { method: 'POST', token: released.session.accessToken });
  check('X3', 'a withdrawn job cannot be accepted again', !lateAccept.ok, `${lateAccept.status} ${lateAccept.payload?.message ?? ''}`);
  const withdrawn = current;

  // X4: reassignment (the API offers the next eligible driver; otherwise dispatch picks one).
  let reassigned = cancel.payload?.nextAssignment;
  if (!reassigned) reassigned = await offer(second);
  const driver = drivers.find((item) => item.id === reassigned.driverId) ?? second;
  const accepted = await request(`/v1/shipments/assignments/${reassigned.id}/accept`, { method: 'POST', token: driver.session.accessToken });
  const acceptedAgain = await request(`/v1/shipments/assignments/${reassigned.id}/accept`, { method: 'POST', token: driver.session.accessToken });
  assignments = await expectOk(shipmentPath('/assignments'), { token: dispatcher.accessToken });
  const active = assignments.filter((item) => item.status === 'ACCEPTED');
  check('X4', 'reassigned driver accepts; a double tap leaves exactly one active assignment', accepted.ok && active.length === 1 && active[0].id === reassigned.id, `${driver.email}, second tap ${acceptedAgain.status}, active ${active.length}`);
  const timeline = (await expectOk(shipmentPath(), { token: dispatcher.accessToken })).timeline ?? [];
  check('X5', 'the shipment history keeps the withdrawn and declined assignments', assignments.some((item) => item.id === withdrawn.id && item.status === 'CANCELLED') && (!declined || assignments.some((item) => item.id === declined.id && item.status === 'REJECTED')), `${assignments.length} assignments, ${timeline.length} timeline entries`);

  // X6: the trip only moves forward.
  await expectOk(shipmentPath('/status'), { method: 'PATCH', token: driver.session.accessToken, body: { status: 'DRIVER_EN_ROUTE', note: 'Exception check: en route.' } });
  const rewind = await request(shipmentPath('/status'), { method: 'PATCH', token: driver.session.accessToken, body: { status: 'DRIVER_ASSIGNED' } });
  const jump = await request(shipmentPath('/status'), { method: 'PATCH', token: driver.session.accessToken, body: { status: 'COMPLETED' } });
  check('X6', 'a driver cannot rewind the trip or mark it completed', !rewind.ok && !jump.ok, `rewind ${rewind.status}, complete ${jump.status}`);

  for (const status of ['ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION', 'DELIVERED']) {
    await expectOk(shipmentPath('/status'), { method: 'PATCH', token: driver.session.accessToken, body: { status, note: `Exception check: ${status.toLowerCase()}.` } });
  }
  await expectOk(trackingPath('/proof-of-delivery'), { method: 'POST', token: driver.session.accessToken, body: { recipientName: 'Exception Check Receiver', note: 'Delivered during the exception check.' } });

  // X7-X10: dispute, refund, repeats.
  const dispute = await request(shipmentPath('/escrow/dispute'), { method: 'POST', token: customer.accessToken, body: { note: 'Exception check: cargo short on delivery (demo).' } });
  check('X7', 'customer can dispute the delivery; the payment is frozen', dispute.ok && dispute.payload?.status === 'DISPUTED', `${dispute.status} ${dispute.payload?.status ?? dispute.payload?.message ?? ''}`);
  const blockedRelease = await request(shipmentPath('/escrow/release'), { method: 'POST', token: admin.accessToken, body: { note: 'Should be refused while disputed.' } });
  check('X8', 'a disputed payment cannot be released', !blockedRelease.ok, `${blockedRelease.status} ${blockedRelease.payload?.message ?? ''}`);
  const refund = await request(shipmentPath('/escrow/refund'), { method: 'POST', token: admin.accessToken, body: { note: 'Exception check: refund after dispute (Paystack test mode).' } });
  const refundAgain = await request(shipmentPath('/escrow/refund'), { method: 'POST', token: admin.accessToken, body: { note: 'Repeat tap.' } });
  check('X9', 'operations refund the customer; a repeated refund changes nothing', refund.payload?.status === 'REFUNDED' && refundAgain.payload?.status === 'REFUNDED', `refund ${refund.payload?.status ?? refund.status}, repeat ${refundAgain.payload?.status ?? refundAgain.status}`);
  const releaseAfter = await request(shipmentPath('/escrow/release'), { method: 'POST', token: admin.accessToken, body: {} });
  const disputeAfter = await request(shipmentPath('/escrow/dispute'), { method: 'POST', token: customer.accessToken, body: { note: 'After refund.' } });
  check('X10', 'a refunded payment cannot then be released or disputed', !releaseAfter.ok && !disputeAfter.ok, `release ${releaseAfter.status}, dispute ${disputeAfter.status}`);
  const lateGps = await request(trackingPath('/location'), { method: 'POST', token: driver.session.accessToken, body: { ...booked.destinationCoordinates, recordedAt: new Date().toISOString() } });
  check('X11', 'GPS sharing stops once the trip is delivered', lateGps.status === 409, `${lateGps.status}`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
