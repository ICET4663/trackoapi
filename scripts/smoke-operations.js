const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

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

async function login(identifier, role) {
  return request('/v1/auth/login', {
    method: 'POST',
    body: {
      identifier,
      password: process.env.SMOKE_PASSWORD || 'password123',
      role,
    },
  });
}

function assertNumber(value, label) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${label} was not a valid number.`);
  }
}

async function main() {
  console.log(`Tracko operations smoke: ${API_BASE_URL}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');

  const readinessPage = await request('/v1/demo/readiness');
  if (!readinessPage.operationsWorkflow?.endpoints?.includes('GET /v1/operations/workflow-readiness')) {
    throw new Error('Demo readiness page does not list operations workflow readiness.');
  }
  console.log('OK demo readiness operations listed');

  const dispatcher = await login(process.env.SMOKE_DISPATCHER_EMAIL || 'dispatcher@tracko.ng', 'DISPATCHER');
  const admin = await login(process.env.SMOKE_ADMIN_EMAIL || 'admin@tracko.ng', 'ADMIN');
  console.log('OK login dispatcher/admin');

  const workflow = await request('/v1/operations/workflow-readiness', {
    accessToken: dispatcher.accessToken,
  });
  assertNumber(workflow.metrics?.pendingKyc, 'pendingKyc');
  assertNumber(workflow.metrics?.verifiedDrivers, 'verifiedDrivers');
  assertNumber(workflow.metrics?.fundedUnassignedShipments, 'fundedUnassignedShipments');
  if (!Array.isArray(workflow.nextActions)) throw new Error('workflow nextActions was not an array.');
  console.log('OK workflow readiness', workflow.nextActions.length, 'actions');

  const assignmentQueue = await request('/v1/operations/assignment-queue', {
    accessToken: dispatcher.accessToken,
  });
  if (!Array.isArray(assignmentQueue.shipments) || !Array.isArray(assignmentQueue.drivers)) {
    throw new Error('Assignment queue did not return shipments and drivers arrays.');
  }
  console.log('OK assignment queue', assignmentQueue.shipments.length, assignmentQueue.drivers.length);

  const escrowLedger = await request('/v1/operations/escrow-ledger', {
    accessToken: admin.accessToken,
  });
  assertNumber(escrowLedger.totalHeld, 'totalHeld');
  if (!Array.isArray(escrowLedger.items)) throw new Error('Escrow ledger did not return items array.');
  console.log('OK escrow ledger', escrowLedger.items.length, 'items');

  console.log('DONE Tracko operations smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko operations smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
