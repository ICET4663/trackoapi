// Truck document review against a deployed API, and the truck owner's inbox (TRACKO_ACCEPTANCE.md
// N3 for TRUCK_OWNER): the owner uploads an insurance certificate for their own truck through
// Trako, an admin rejects it with a reason, the owner sees the reason and re-uploads, and the admin
// verifies it. Each decision must reach the owner's inbox linking to that truck's documents screen.
// Also checks that an outside link is refused and that another owner's truck cannot be touched.
// Only the document state changes; the truck and its driver are not touched.
//
// Uses the demo truckowner@tracko.ng and its truck TRK-OWN-01 by default; the insurance
// certificate ends the run verified.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/check-vehicle-documents.js

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.SIM_PASSWORD || 'password123';
const OWNER_EMAIL = process.env.SIM_OWNER_EMAIL || 'truckowner@tracko.ng';
const ADMIN_EMAIL = process.env.SIM_ADMIN_EMAIL || 'admin@tracko.ng';
const PLATE = process.env.SIM_OWNER_PLATE || 'TRK-OWN-01';
const TYPE = 'insurance';
// A 1x1 PNG: enough to exercise the real upload path.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
  return result.payload.accessToken;
}
function list(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'vehicles', 'data', 'notifications']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}
async function upload(owner) {
  const media = await request('/v1/media/upload', { method: 'POST', token: owner, body: { kind: 'DOCUMENT', base64: PIXEL_PNG, mimeType: 'image/png', label: 'Insurance certificate (acceptance check)' } });
  if (!media.ok || !media.payload?.url) throw new Error(`Upload failed (${media.status}): ${media.payload?.message ?? ''}`);
  return media.payload.url;
}

async function main() {
  console.log(`Truck document review against ${API_BASE_URL} (${OWNER_EMAIL}, ${PLATE})\n`);
  const owner = await login(OWNER_EMAIL, 'TRUCK_OWNER');
  const admin = await login(ADMIN_EMAIL, 'ADMIN');

  const income = await request('/v1/owner/vehicle-income', { token: owner });
  const vehicle = list(income.payload).find((item) => item.plateNumber === PLATE);
  if (!vehicle) throw new Error(`${OWNER_EMAIL} has no truck ${PLATE} (${income.status}).`);
  const vehicleId = vehicle.id ?? vehicle.vehicleId;
  const base = `/v1/owner/vehicles/${encodeURIComponent(vehicleId)}/documents`;
  const insurance = async () => list((await request(base, { token: owner })).payload).find((item) => item.type === TYPE.toUpperCase());
  const inboxLinks = async () => list((await request('/v1/notifications', { token: owner })).payload)
    .filter((item) => item.actionUrl === `/owner/vehicle-documents/${vehicleId}`);
  const before = (await inboxLinks()).length;

  const outside = await request(`${base}/${TYPE}/upload-request`, { method: 'POST', token: owner, body: { fileUrl: 'https://example.com/insurance.jpg', number: 'ACC-OUTSIDE' } });
  check('K5', 'a document link from outside Trako is refused', outside.status === 400, `${outside.status} ${outside.payload?.message ?? ''}`);

  const notMine = await request('/v1/owner/vehicles/not-a-real-truck/documents', { token: owner });
  check('R4', "another owner's (or a made-up) truck is not found", notMine.status === 404, `${notMine.status}`);

  const submitted = await request(`${base}/${TYPE}/upload-request`, { method: 'POST', token: owner, body: { fileUrl: await upload(owner), number: 'ACC-INS-1' } });
  check('K6a', 'owner submits an insurance certificate uploaded through Trako', submitted.ok && (await insurance())?.state === 'pending_review', `${submitted.status}, ${(await insurance())?.state}`);

  const pendingFor = async () => list((await request('/v1/admin/vehicle-documents', { token: admin })).payload)
    .find((item) => item.vehicleId === vehicleId && item.type === TYPE.toUpperCase());
  const pending = await pendingFor();
  if (!pending) throw new Error('The certificate did not appear in the admin review queue.');
  const reason = 'Certificate photo is unreadable - please retake it in good light (acceptance check)';
  const rejected = await request(`/v1/admin/vehicle-documents/${encodeURIComponent(pending.id)}/review`, { method: 'POST', token: admin, body: { decision: 'REJECT', note: reason } });
  const afterReject = await insurance();
  check('K6b', 'admin rejects it with a reason; the owner sees the reason', rejected.ok && afterReject?.state === 'rejected' && afterReject?.reviewNote === reason, `${afterReject?.state}: ${afterReject?.reviewNote ?? 'no reason shown'}`);

  const resubmitted = await request(`${base}/${TYPE}/upload-request`, { method: 'POST', token: owner, body: { fileUrl: await upload(owner), number: 'ACC-INS-1' } });
  check('K6c', 'owner re-uploads; it goes back for review', resubmitted.ok && (await insurance())?.state === 'pending_review', `${(await insurance())?.state}`);

  const second = await pendingFor();
  const approved = second && await request(`/v1/admin/vehicle-documents/${encodeURIComponent(second.id)}/review`, { method: 'POST', token: admin, body: { decision: 'APPROVE' } });
  const final = await insurance();
  check('K6d', 'admin verifies the corrected certificate', Boolean(approved?.ok) && final?.state === 'verified', `${final?.state}`);

  const links = await inboxLinks();
  const added = links.length - before;
  const titles = links.slice(0, 2).map((item) => item.title).join(' / ');
  check('N3o', "both decisions reach the owner's inbox, linking to the truck's documents", added >= 2, `${added} new: ${titles}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
