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
  if (process.env.SMOKE_CUSTOMER_ACCESS_TOKEN) {
    const me = await request('/v1/auth/me', {
      accessToken: process.env.SMOKE_CUSTOMER_ACCESS_TOKEN,
    });
    return {
      accessToken: process.env.SMOKE_CUSTOMER_ACCESS_TOKEN,
      user: me,
    };
  }

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
      'For the deployed API, set SMOKE_CUSTOMER_EMAIL and SMOKE_PASSWORD to a real registered customer account, or set SMOKE_CUSTOMER_ACCESS_TOKEN from a logged-in customer session.',
      'Password example:',
      '$env:API_BASE_URL="https://trackoapi.vercel.app"; $env:SMOKE_CUSTOMER_EMAIL="you@example.com"; $env:SMOKE_PASSWORD="your-password"; npm run smoke:payments',
      'Token example:',
      '$env:API_BASE_URL="https://trackoapi.vercel.app"; $env:SMOKE_CUSTOMER_ACCESS_TOKEN="ey..."; npm run smoke:payments',
    ].join('\n');
    throw new Error(`${hint}\n${error.message || error}`);
  }
}

async function main() {
  console.log(`Tracko payment smoke: ${API_BASE_URL}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');
  const paymentIntegration = health.integrations?.find?.((integration) => integration.name === 'payments');
  if (paymentIntegration?.mode !== 'configured') {
    throw new Error(`Paystack is not configured (${paymentIntegration?.mode || 'unknown'}).`);
  }
  console.log('OK payment mode paystack configured');

  const customerEmail = process.env.SMOKE_CUSTOMER_EMAIL || 'customer@tracko.ng';
  const customer = await login(customerEmail, 'CUSTOMER');
  console.log('OK customer login', customer.user?.email || 'customer');

  if (process.env.PAYSTACK_VERIFY_REFERENCE) {
    const reference = process.env.PAYSTACK_VERIFY_REFERENCE;
    const verification = await request(`/v1/payments/paystack/verify/${encodeURIComponent(reference)}`, {
      accessToken: customer.accessToken,
    });
    if (!verification.verified) {
      throw new Error(verification.message || `Paystack reference ${reference} is not verified.`);
    }
    console.log('OK Paystack reference verified', reference);
    console.log('DONE Tracko payment verification passed');
    return;
  }

  const quoteInput = {
    originLatitude: 6.5244,
    originLongitude: 3.3792,
    destinationLatitude: 7.3775,
    destinationLongitude: 3.947,
    truckType: 'Box truck',
    weightTons: 8,
    volumeM3: 24,
  };
  const quote = await request('/v1/maps/route-estimate', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: quoteInput,
  });
  if (!quote.quoteToken || !quote.quotedPriceKobo) {
    throw new Error('The route estimate did not return a signed quote.');
  }
  console.log('OK signed quote', `${quote.distanceKm}km`, `${quote.quotedPriceKobo} kobo`);

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
      volumeM3: 24,
      truckType: 'Box truck',
      pickupContactPhone: '+2348000000000',
      quoteToken: quote.quoteToken,
    },
  });
  console.log('OK shipment created', shipment.id);

  const payment = await request('/v1/payments/escrow/initialize', {
    method: 'POST',
    accessToken: customer.accessToken,
    body: {
      shipmentId: shipment.id,
      currency: 'NGN',
      method: process.env.SMOKE_PAYMENT_METHOD || 'card',
      callbackUrl: process.env.SMOKE_PAYMENT_CALLBACK_URL || 'https://www.trako.com.ng/customer/escrow',
    },
  });
  console.log('OK escrow initialized', payment.provider, payment.providerReference);

  if (payment.authorizationUrl) {
    console.log('OK checkout URL returned', payment.authorizationUrl);
    console.log('NEXT Complete the Paystack test checkout, then verify this reference:');
    console.log(`$env:PAYSTACK_VERIFY_REFERENCE="${payment.providerReference}"; npm run smoke:payments`);
  } else {
    console.log('OK mock/no-checkout mode', payment.message);
  }

  const escrow = await request(`/v1/shipments/${encodeURIComponent(shipment.id)}/escrow`, {
    accessToken: customer.accessToken,
  });
  console.log('OK escrow status', escrow.status);

  console.log('DONE Tracko payment smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko payment smoke');
  console.error(error.message || error);
  process.exitCode = 1;
});
