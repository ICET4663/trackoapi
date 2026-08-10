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
      password: process.env.SMOKE_PASSWORD || 'password123',
      role,
    },
  });
}

async function main() {
  console.log(`Tracko payout smoke: ${baseUrl}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');

  const customer = await login(process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng', 'CUSTOMER');
  const driver = await login(process.env.SMOKE_DRIVER_EMAIL || 'driver@tracko.ng', 'DRIVER');
  const admin = await login(process.env.SMOKE_ADMIN_EMAIL || 'admin@tracko.ng', 'ADMIN');
  console.log('OK login customer/driver/admin');

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
    accessToken: admin.accessToken,
    body: { driverId: driver.user?.id },
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
    accessToken: admin.accessToken,
  });
  const released = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow/release`, {
    method: 'POST',
    accessToken: admin.accessToken,
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

  const payoutRequests = await request('/v1/admin/payout-requests', { accessToken: admin.accessToken });
  const payout = payoutRequests.find((item) => item.id === withdrawal.id);
  if (!payout) throw new Error('Withdrawal request was not visible in admin payout requests.');
  console.log('OK admin payout queue', payout.status);

  await request(`/v1/admin/payout-requests/${encodeURIComponent(withdrawal.id)}/review`, {
    method: 'POST',
    accessToken: admin.accessToken,
    body: { decision: 'APPROVED', note: 'Smoke test approval.' },
  });
  const paid = await request(`/v1/admin/payout-requests/${encodeURIComponent(withdrawal.id)}/review`, {
    method: 'POST',
    accessToken: admin.accessToken,
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
