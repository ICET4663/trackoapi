const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'password123';

const checks = [];

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return payload;
}

async function check(label, fn) {
  try {
    const detail = await fn();
    checks.push({ label, ok: true, detail });
    console.log(`OK ${label}${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    checks.push({ label, ok: false, detail: error.message || String(error) });
    console.log(`FAIL ${label} - ${error.message || error}`);
  }
}

async function login(identifier, role) {
  return request('/v1/auth/login', {
    method: 'POST',
    body: {
      identifier,
      password: SMOKE_PASSWORD,
      role,
    },
  });
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${label} was not a valid number.`);
  }
}

async function main() {
  console.log(`Tracko MVP smoke: ${API_BASE_URL}`);

  let customer;
  let dispatcher;
  let admin;

  await check('health', async () => {
    const health = await request('/v1/health');
    return health.service || health.name || 'tracko-api';
  });

  await check('demo readiness', async () => {
    const readiness = await request('/v1/demo/readiness');
    if (!readiness.authentication?.jwtLogin) throw new Error('Auth readiness is missing.');
    if (!readiness.escrowPayment?.endpoints?.includes('POST /v1/payments/escrow/initialize')) {
      throw new Error('Escrow readiness is missing.');
    }
    if (!readiness.kyc?.endpoints?.includes('POST /v1/kyc')) throw new Error('KYC readiness is missing.');
    if (!readiness.operationsWorkflow?.endpoints?.includes('GET /v1/operations/workflow-readiness')) {
      throw new Error('Operations readiness is missing.');
    }
    return readiness.ok ? 'deployable' : 'needs attention';
  });

  await check('integrations status', async () => {
    const integrations = await request('/v1/integrations/status');
    return `payments=${integrations.payments?.mode || 'unknown'}, kyc=${integrations.kyc?.mode || 'unknown'}, maps=${integrations.maps?.mode || 'unknown'}`;
  });

  await check('customer login', async () => {
    customer = await login(process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng', 'CUSTOMER');
    if (!customer.accessToken) throw new Error('Customer login did not return an access token.');
    return customer.user?.email || 'customer';
  });

  await check('dispatcher login', async () => {
    dispatcher = await login(process.env.SMOKE_DISPATCHER_EMAIL || 'dispatcher@tracko.ng', 'DISPATCHER');
    if (!dispatcher.accessToken) throw new Error('Dispatcher login did not return an access token.');
    return dispatcher.user?.email || 'dispatcher';
  });

  await check('admin login', async () => {
    admin = await login(process.env.SMOKE_ADMIN_EMAIL || 'admin@tracko.ng', 'ADMIN');
    if (!admin.accessToken) throw new Error('Admin login did not return an access token.');
    return admin.user?.email || 'admin';
  });

  await check('customer KYC status', async () => {
    if (!customer?.accessToken) throw new Error('Customer session missing.');
    const kyc = await request('/v1/kyc', { accessToken: customer.accessToken });
    return kyc.verificationStatus || kyc.submission?.status || 'available';
  });

  await check('operations workflow readiness', async () => {
    if (!dispatcher?.accessToken) throw new Error('Dispatcher session missing.');
    const workflow = await request('/v1/operations/workflow-readiness', { accessToken: dispatcher.accessToken });
    requireNumber(workflow.metrics?.pendingKyc, 'pendingKyc');
    requireNumber(workflow.metrics?.verifiedDrivers, 'verifiedDrivers');
    if (!Array.isArray(workflow.nextActions)) throw new Error('nextActions was not an array.');
    return `${workflow.nextActions.length} actions`;
  });

  await check('assignment queue', async () => {
    if (!dispatcher?.accessToken) throw new Error('Dispatcher session missing.');
    const queue = await request('/v1/operations/assignment-queue', { accessToken: dispatcher.accessToken });
    if (!Array.isArray(queue.shipments) || !Array.isArray(queue.drivers)) {
      throw new Error('Assignment queue did not return shipments and drivers arrays.');
    }
    return `${queue.shipments.length} shipments, ${queue.drivers.length} drivers`;
  });

  await check('escrow ledger', async () => {
    if (!admin?.accessToken) throw new Error('Admin session missing.');
    const ledger = await request('/v1/operations/escrow-ledger', { accessToken: admin.accessToken });
    requireNumber(ledger.totalHeld, 'totalHeld');
    if (!Array.isArray(ledger.items)) throw new Error('Escrow ledger did not return items.');
    return `${ledger.items.length} records`;
  });

  const failed = checks.filter((item) => !item.ok);
  console.log(`SUMMARY ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.log('FAILED CHECKS');
    for (const item of failed) console.log(`- ${item.label}: ${item.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log('DONE Tracko MVP smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko MVP smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
