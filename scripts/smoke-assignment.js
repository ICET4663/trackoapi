const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const SHIPMENT_ID = process.env.SMOKE_SHIPMENT_ID?.trim();
const DEFAULT_PASSWORD = process.env.SMOKE_PASSWORD || 'password123';

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
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${payload.message || text}`);
  }
  return payload;
}

async function login(role, defaultEmail) {
  const identifier = process.env[`SMOKE_${role}_EMAIL`] || defaultEmail;
  const password = process.env[`SMOKE_${role}_PASSWORD`] || DEFAULT_PASSWORD;
  const session = await request('/v1/auth/login', {
    method: 'POST',
    body: { identifier, password, role },
  });
  if (!session.accessToken) throw new Error(`${role} login did not return an access token.`);
  return session;
}

function requireShipmentId() {
  if (!SHIPMENT_ID) {
    throw new Error('Set SMOKE_SHIPMENT_ID to the funded shipment id returned by smoke:payments.');
  }
}

async function main() {
  requireShipmentId();
  console.log(`Tracko assignment smoke: ${API_BASE_URL}`);
  console.log(`Shipment: ${SHIPMENT_ID}`);

  const [admin, dispatcher] = await Promise.all([
    login('ADMIN', 'admin@tracko.ng'),
    login('DISPATCHER', 'dispatcher@tracko.ng'),
  ]);
  console.log('OK admin and dispatcher login');

  const escrow = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow`, {
    accessToken: admin.accessToken,
  });
  if (!['FUNDED', 'HELD', 'RELEASE_READY'].includes(escrow.status)) {
    throw new Error(`Escrow is ${escrow.status || 'unknown'}. Complete and verify the Paystack checkout before approval.`);
  }
  console.log('OK escrow funded', escrow.status);

  let shipment = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}?role=ADMIN`, {
    accessToken: admin.accessToken,
  });
  if (!shipment.adminApproved) {
    shipment = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/approve`, {
      method: 'POST',
      accessToken: admin.accessToken,
    });
    console.log('OK admin approved shipment');
  } else {
    console.log('OK shipment was already admin approved');
  }

  const assignments = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/assignments`, {
    accessToken: dispatcher.accessToken,
  });
  let assignment = assignments.find((item) => ['OFFERED', 'ACCEPTED'].includes(item.status));
  if (!assignment) {
    assignment = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/assignments/best-match`, {
      method: 'POST',
      accessToken: dispatcher.accessToken,
    });
    console.log('OK best eligible driver offered assignment');
  } else {
    console.log(`OK existing ${assignment.status.toLowerCase()} assignment reused`);
  }

  if (!assignment?.id || !assignment?.driver?.id) {
    throw new Error('The assignment response did not include assignment and driver identifiers.');
  }
  console.log('Assignment:', assignment.id);
  console.log('Driver:', assignment.driver.fullName || assignment.driver.email || assignment.driver.id);
  console.log('Truck:', assignment.vehicle?.plateNumber || assignment.vehicle?.type || 'verified truck');
  console.log('NEXT Sign in as the assigned driver and accept the load from the Jobs screen.');
  console.log('DONE Tracko approval and assignment checkpoint passed');
}

main().catch((error) => {
  console.error('FAILED Tracko assignment smoke');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
