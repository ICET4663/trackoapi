const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function login(identifier, role) {
  const password = passwordForRole(role);
  try {
    const response = await request('/v1/auth/login', {
      method: 'POST',
      body: {
        identifier,
        password,
        role,
      },
    });
    return normalizeActor(response, role, identifier);
  } catch (error) {
    throw new Error(
      `${role} login failed for ${identifier}. Set the real deployed password with ${passwordEnvForRole(role)} or SMOKE_PASSWORD, or pass ${tokenEnvForRole(role)}. ${error.message}`,
    );
  }
}

function normalizeActor(response, role, email) {
  const accessToken =
    response?.accessToken ||
    response?.token ||
    response?.session?.accessToken ||
    response?.data?.accessToken ||
    response?.data?.session?.accessToken;
  const user = response?.user || response?.data?.user || {};
  const payload = accessToken ? decodeJwtPayload(accessToken) : {};

  if (!accessToken) {
    throw new Error(`${role} login response did not include an access token. Response keys: ${Object.keys(response || {}).join(', ')}`);
  }

  return {
    ...response,
    accessToken,
    user: {
      ...user,
      id: user.id || payload.sub || process.env[`SMOKE_${role}_ID`],
      email: user.email || payload.email || email,
      role: user.role || payload.role || role,
    },
  };
}

function passwordForRole(role) {
  return process.env[passwordEnvForRole(role)] || process.env.SMOKE_PASSWORD || 'password123';
}

function passwordEnvForRole(role) {
  return `SMOKE_${role}_PASSWORD`;
}

function tokenEnvForRole(role) {
  return `SMOKE_${role}_ACCESS_TOKEN`;
}

function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return {};
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function actor(role, defaultEmail) {
  const token = process.env[tokenEnvForRole(role)];
  if (token) {
    const payload = decodeJwtPayload(token);
    return {
      accessToken: token,
      user: {
        id: process.env[`SMOKE_${role}_ID`] || payload.sub || payload.id,
        email: payload.email || defaultEmail,
        role,
      },
    };
  }

  return login(process.env[`SMOKE_${role}_EMAIL`] || defaultEmail, role);
}

async function operationsActor() {
  if (process.env.SMOKE_OPERATIONS_ACCESS_TOKEN) {
    const payload = decodeJwtPayload(process.env.SMOKE_OPERATIONS_ACCESS_TOKEN);
    const role = process.env.SMOKE_OPERATIONS_ROLE || payload.role || 'DISPATCHER';
    return {
      role,
      accessToken: process.env.SMOKE_OPERATIONS_ACCESS_TOKEN,
      user: {
        id: process.env.SMOKE_OPERATIONS_ID || payload.sub || payload.id,
        email: payload.email || process.env.SMOKE_OPERATIONS_EMAIL || `${role.toLowerCase()}@tracko.ng`,
        role,
      },
    };
  }

  const preferredRole = process.env.SMOKE_OPERATIONS_ROLE || 'ADMIN';
  const candidates = preferredRole === 'DISPATCHER' ? ['DISPATCHER', 'ADMIN'] : ['ADMIN', 'DISPATCHER'];
  const errors = [];

  for (const role of candidates) {
    try {
      const account = await actor(role, role === 'ADMIN' ? 'admin@tracko.ng' : 'dispatcher@tracko.ng');
      return { ...account, role };
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`Operations login failed. Use admin or dispatcher credentials. ${errors.join(' | ')}`);
}

async function main() {
  console.log(`Tracko payout smoke: ${baseUrl}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');

  const customer = await actor('CUSTOMER', 'customer@tracko.ng');
  const driver = await actor('DRIVER', 'driver@tracko.ng');
  const operations = await operationsActor();
  console.log(`OK login customer/driver/${operations.role.toLowerCase()}`);

  for (const [label, account] of [['customer', customer], ['driver', driver], ['operations', operations]]) {
    if (!account.accessToken) throw new Error(`${label} login did not provide an access token.`);
  }

  if (!driver.user?.id) {
    throw new Error('Driver id is required for assignment. Set SMOKE_DRIVER_ID or use a JWT access token that includes sub.');
  }

  const shipment = await request('/v1/shipments', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      origin: 'Lagos',
      destination: 'Abeokuta',
      originCoordinates: { latitude: 6.5244, longitude: 3.3792 },
      destinationCoordinates: { latitude: 7.1475, longitude: 3.3619 },
      cargoType: 'Payout smoke test cargo',
      quantity: '1 truckload',
      weightTons: 6,
      truckType: 'Box truck',
      pickupContactPhone: '+2348000000000',
      quotedPriceKobo: 18000000,
      cargoValueKobo: 18000000,
    },
  });
  console.log('OK shipment created', shipment.id);

  const assignment = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/assignments`, {
    method: 'POST',
    accessToken: operations.accessToken,
    body: { driverId: driver.user.id },
  });
  console.log('OK assignment offered', assignment.id);

  await request(`/v1/shipments/assignments/${encodeURIComponent(assignment.id)}/accept`, {
    method: 'POST',
    accessToken: driver.accessToken,
  });
  console.log('OK assignment accepted');

  const payment = await request('/v1/payments/escrow/initialize', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: { shipmentId: shipment.id, currency: 'NGN' },
  });
  console.log('OK escrow initialized', payment.providerReference);

  await request(`/v1/tracking/shipments/${encodeURIComponent(shipment.id)}/proof-of-delivery`, {
    method: 'POST',
    accessToken: driver.accessToken,
    body: {
      recipientName: 'Payout Smoke Receiver',
      note: 'Delivery proof submitted for payout smoke test.',
    },
  });
  console.log('OK proof submitted');

  for (const check of ['arrivalConfirmed', 'customerDeliveryConfirmed', 'disputeWindowClear']) {
    await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow/checks/${check}`, {
      method: 'POST',
      accessToken: customer.accessToken,
    });
  }
  console.log('OK customer release checks');

  await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow/checks/platformApproved`, {
    method: 'POST',
    accessToken: operations.accessToken,
  });
  const released = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow/release`, {
    method: 'POST',
    accessToken: operations.accessToken,
    body: { note: 'Smoke test release after delivery proof and customer confirmation.' },
  });
  console.log('OK escrow release', released.status);

  const earnings = await request('/v1/driver/earnings', { accessToken: driver.accessToken });
  console.log('OK driver earnings', earnings.availableBalanceLabel);
  if (!earnings.availableBalance || earnings.availableBalance <= 0) {
    throw new Error('Driver available balance did not increase after escrow release.');
  }

  const withdrawalAmount = Math.min(earnings.availableBalance, 1000000);
  const withdrawal = await request('/v1/driver/withdrawals', {
    method: 'POST',
    accessToken: driver.accessToken,
    body: { amountKobo: withdrawalAmount, note: 'Smoke test withdrawal request.' },
  });
  console.log('OK withdrawal requested', withdrawal.id, withdrawal.amountLabel);

  const payoutRequests = await request('/v1/admin/payout-requests', { accessToken: operations.accessToken });
  const payout = payoutRequests.find((item) => item.id === withdrawal.id);
  if (!payout) throw new Error('Withdrawal request was not visible in admin payout requests.');
  console.log('OK admin payout queue', payout.status);

  await request(`/v1/admin/payout-requests/${encodeURIComponent(withdrawal.id)}/review`, {
    method: 'POST',
    accessToken: operations.accessToken,
    body: { decision: 'APPROVED', note: 'Smoke test approval.' },
  });
  const paid = await request(`/v1/admin/payout-requests/${encodeURIComponent(withdrawal.id)}/review`, {
    method: 'POST',
    accessToken: operations.accessToken,
    body: { decision: 'PAID', note: 'Smoke test marked as paid.' },
  });
  console.log('OK payout marked paid', paid.status);

  console.log('DONE Tracko payout smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko payout smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
