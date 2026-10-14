// Driver document review against a deployed API (TRACKO_ACCEPTANCE.md K3, K5): the driver
// uploads a licence photo through Trako, an admin rejects it with a reason, the driver sees
// the reason and re-uploads, and the admin verifies it. Also checks that an outside link
// is refused. Only document state changes; the driver's account status is not touched.
//
// Uses the demo driver@tracko.ng by default; its licence ends the run verified.
//
//   API_BASE_URL=https://trackoapi.vercel.app node scripts/check-driver-documents.js

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.SIM_PASSWORD || 'password123';
const DRIVER_EMAIL = process.env.SIM_DRIVER_EMAIL || 'driver@tracko.ng';
const ADMIN_EMAIL = process.env.SIM_ADMIN_EMAIL || 'admin@tracko.ng';
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
async function upload(driver) {
  const media = await request('/v1/media/upload', { method: 'POST', token: driver, body: { kind: 'DOCUMENT', base64: PIXEL_PNG, mimeType: 'image/png', label: 'Driver licence (acceptance check)' } });
  if (!media.ok || !media.payload?.url) throw new Error(`Upload failed (${media.status}): ${media.payload?.message ?? ''}`);
  return media.payload.url;
}
async function licence(driver) {
  return (await request('/v1/driver/documents/license', { token: driver })).payload;
}

async function main() {
  console.log(`Driver document review against ${API_BASE_URL} (${DRIVER_EMAIL})\n`);
  const driver = await login(DRIVER_EMAIL, 'DRIVER');
  const admin = await login(ADMIN_EMAIL, 'ADMIN');

  const outside = await request('/v1/driver/documents/license/upload-request', { method: 'POST', token: driver, body: { fileUrl: 'https://example.com/licence.jpg', number: 'ACC-OUTSIDE' } });
  check('K5', 'a document link from outside Trako is refused', outside.status === 400, `${outside.status} ${outside.payload?.message ?? ''}`);

  const firstUrl = await upload(driver);
  const submitted = await request('/v1/driver/documents/license/upload-request', { method: 'POST', token: driver, body: { fileUrl: firstUrl, number: 'ACC-LIC-1' } });
  check('K3a', 'driver submits a licence photo uploaded through Trako', submitted.ok && (await licence(driver))?.state === 'pending_review', `${submitted.status}, ${(await licence(driver))?.state}`);

  const queue = await request('/v1/admin/driver-documents', { token: admin });
  const pending = (Array.isArray(queue.payload) ? queue.payload : []).find((item) => item.email === DRIVER_EMAIL && /licen/i.test(item.title));
  if (!pending) throw new Error('The licence did not appear in the admin review queue.');
  const reason = 'Photo is unreadable - please retake it in good light (acceptance check)';
  const rejected = await request(`/v1/admin/driver-documents/${encodeURIComponent(pending.id)}/review`, { method: 'POST', token: admin, body: { decision: 'REJECT', note: reason } });
  const afterReject = await licence(driver);
  check('K3b', 'admin rejects it with a reason; the driver sees the reason', rejected.ok && afterReject?.state === 'rejected' && afterReject?.reviewNote === reason, `${afterReject?.state}: ${afterReject?.reviewNote ?? 'no reason shown'}`);

  const secondUrl = await upload(driver);
  const resubmitted = await request('/v1/driver/documents/license/upload-request', { method: 'POST', token: driver, body: { fileUrl: secondUrl, number: 'ACC-LIC-1' } });
  check('K3c', 'driver re-uploads; it goes back for review', resubmitted.ok && (await licence(driver))?.state === 'pending_review', `${(await licence(driver))?.state}`);

  const again = await request('/v1/admin/driver-documents', { token: admin });
  const second = (Array.isArray(again.payload) ? again.payload : []).find((item) => item.email === DRIVER_EMAIL && /licen/i.test(item.title));
  const approved = second && await request(`/v1/admin/driver-documents/${encodeURIComponent(second.id)}/review`, { method: 'POST', token: admin, body: { decision: 'APPROVE' } });
  const final = await licence(driver);
  check('K3d', 'admin verifies the corrected document', Boolean(approved?.ok) && final?.state === 'verified', `${final?.state}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
