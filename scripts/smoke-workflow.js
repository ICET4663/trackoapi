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
  return request('/v1/auth/login', {
    method: 'POST',
    body: {
      identifier,
      password: 'password123',
      role,
    },
  });
}

async function main() {
  console.log(`Tracko smoke workflow: ${baseUrl}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service);

  const customer = await login('customer@tracko.ng', 'CUSTOMER');
  const dispatcher = await login('dispatcher@tracko.ng', 'DISPATCHER');
  const driver = await login('driver@tracko.ng', 'DRIVER');
  console.log('OK login customer/dispatcher/driver');

  const shipment = await request('/v1/shipments', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      origin: 'Lagos',
      destination: 'Abuja',
      originCoordinates: { latitude: 6.5244, longitude: 3.3792 },
      destinationCoordinates: { latitude: 9.0765, longitude: 7.3986 },
      cargoType: 'Consumer goods',
      quantity: '1 truckload',
      weightTons: 12,
      truckType: 'Flatbed truck',
      pickupContactPhone: '+2348000000000',
    },
  });
  console.log('OK shipment created', shipment.id);

  const drivers = await request('/v1/shipments/dispatch/available-drivers', {
    accessToken: dispatcher.accessToken,
  });
  const selectedDriver = drivers[0]?.id || 'preview-driver';

  const assignment = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/assignments`, {
    method: 'POST',
    accessToken: dispatcher.accessToken,
    body: { driverId: selectedDriver },
  });
  console.log('OK assignment offered', assignment.id);

  const accepted = await request(`/v1/shipments/assignments/${encodeURIComponent(assignment.id)}/accept`, {
    method: 'POST',
    accessToken: driver.accessToken,
  });
  console.log('OK assignment response', accepted.status);

  const location = await request(`/v1/tracking/shipments/${encodeURIComponent(shipment.id)}/location`, {
    method: 'POST',
    accessToken: driver.accessToken,
    body: {
      latitude: 6.6018,
      longitude: 3.3515,
      speedKph: 42,
      note: 'Driver departed pickup area.',
    },
  });
  console.log('OK location ping', location.id);

  const proof = await request(`/v1/tracking/shipments/${encodeURIComponent(shipment.id)}/proof-of-delivery`, {
    method: 'POST',
    accessToken: driver.accessToken,
    body: {
      recipientName: 'Preview Receiver',
      note: 'Cargo delivered in good condition.',
    },
  });
  console.log('OK proof of delivery', proof.id);

  const notifications = await request('/v1/notifications', {
    accessToken: customer.accessToken,
  });
  console.log('OK notifications', Array.isArray(notifications) ? notifications.length : 0);

  const integrations = await request('/v1/integrations/status');
  console.log('OK integrations', integrations.payments.mode, integrations.kyc.mode, integrations.maps.mode);

  console.log('DONE Tracko smoke workflow passed');
}

main().catch((error) => {
  console.error('FAILED Tracko smoke workflow');
  console.error(error.message);
  process.exitCode = 1;
});
