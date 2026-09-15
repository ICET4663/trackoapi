const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
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
  return { response, payload };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function rolePassword(role) {
  return process.env[`SMOKE_${role}_PASSWORD`] || DEFAULT_PASSWORD;
}

async function login(identifier, role) {
  const { response, payload } = await request('/v1/auth/login', {
    method: 'POST',
    body: { identifier, password: rolePassword(role), role },
  });
  requireValue(response.ok, `${role} login returned HTTP ${response.status}: ${payload.message || 'unknown error'}`);
  requireValue(payload.accessToken, `${role} login did not return an access token`);
  return payload;
}

async function main() {
  console.log(`Tracko authentication smoke: ${API_BASE_URL}`);

  const health = await request('/v1/health');
  requireValue(health.response.ok && health.payload.ok === true, 'API health check failed');
  console.log('OK API health');

  const anonymous = await request('/v1/auth/me');
  requireValue(anonymous.response.status === 401, `anonymous /v1/auth/me returned HTTP ${anonymous.response.status}`);
  console.log('OK protected session endpoint rejects anonymous access');

  const accounts = [
    ['CUSTOMER', process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng'],
    ['DRIVER', process.env.SMOKE_DRIVER_EMAIL || 'driver@tracko.ng'],
    ['DISPATCHER', process.env.SMOKE_DISPATCHER_EMAIL || 'dispatcher@tracko.ng'],
    ['ADMIN', process.env.SMOKE_ADMIN_EMAIL || 'admin@tracko.ng'],
  ];

  for (const [role, identifier] of accounts) {
    const session = await login(identifier, role);
    const me = await request('/v1/auth/me', { accessToken: session.accessToken });
    requireValue(me.response.ok, `${role} session lookup returned HTTP ${me.response.status}`);
    requireValue(me.payload.role === role, `${role} session resolved as ${me.payload.role || 'unknown'}`);
    requireValue(me.payload.id || me.payload.sub, `${role} session did not include a user id`);
    console.log(`OK ${role.toLowerCase()} login and session identity`);
  }

  const invalid = await request('/v1/auth/login', {
    method: 'POST',
    body: {
      identifier: process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng',
      password: `invalid-${Date.now()}`,
      role: 'CUSTOMER',
    },
  });
  requireValue(invalid.response.status === 401, `invalid login returned HTTP ${invalid.response.status}`);
  console.log('OK invalid credentials are rejected');
  console.log('DONE Tracko authentication smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko authentication smoke');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
