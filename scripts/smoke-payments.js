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
  const password = process.env.SMOKE_PASSWORD || process.env.SMOKE_CUSTOMER_PASSWORD || 'password123';
  try {
    return await request('/v1/auth/login', {
      method: 'POST',
      body: {
        identifier,
        password,
        role,
      },
    });
  } catch (error) {
    const hint = [
      'Customer login failed.',
      'For the deployed API, set SMOKE_CUSTOMER_EMAIL and SMOKE_PASSWORD to a real registered customer account.',
      'Example:',
      '$env:API_BASE_URL="https://trackoapi.vercel.app"; $env:SMOKE_CUSTOMER_EMAIL="you@example.com"; $env:SMOKE_PASSWORD="your-password"; npm run smoke:payments',
    ].join('\n');
    throw new Error(`${hint}\n${error.message || error}`);
  }
}

async function main() {
  console.log(`Tracko payment smoke: ${API_BASE_URL}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');

  const integrations = await request('/v1/integrations/status');
  console.log('OK payment mode', integrations.payments?.provider, integrations.payments?.mode);

  const customerEmail = process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng';
  const customer = await login(customerEmail, 'CUSTOMER');
  console.log('OK customer login', customer.user?.email || 'customer');

  const shipment = await request('/v1/shipments', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      origin: 'Lagos',
      destination: 'Ibadan',
      originCoordinates: { latitude: 6.5244, longitude: 3.3792 },
      destinationCoordinates: { latitude: 7.3775, longitude: 3.947 },
      cargoType: 'Payment smoke test cargo',
      quantity: '1 truckload',
      weightTons: 8,
      truckType: 'Box truck',
      pickupContactPhone: '+2348000000000',
    },
  });
  console.log('OK shipment created', shipment.id);

  const payment = await request('/v1/payments/escrow/initialize', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      shipmentId: shipment.id,
      amount: shipment.quotedPriceKobo || 25000000,
      currency: 'NGN',
      customerEmail: customer.user?.email,
    },
  });
  console.log('OK escrow initialized', payment.provider, payment.providerReference);

  if (payment.authorizationUrl) {
    console.log('OK checkout URL returned', payment.authorizationUrl);
  } else {
    console.log('OK mock/no-checkout mode', payment.message);
  }

  const escrow = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow`, {
    accessToken: customer.accessToken,
  });
  console.log('OK escrow status', escrow.status);

  if (process.env.PAYSTACK_VERIFY_REFERENCE) {
    const verification = await request(`/v1/payments/paystack/verify/${encodeURIComponent(process.env.PAYSTACK_VERIFY_REFERENCE)}`, {
      accessToken: customer.accessToken,
    });
    console.log('OK Paystack reference checked', verification.verified, verification.message);
  } else {
    console.log('SKIP Paystack verification: set PAYSTACK_VERIFY_REFERENCE after making a test payment.');
  }

  console.log('DONE Tracko payment smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko payment smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
