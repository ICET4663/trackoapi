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

async function updateStatus(status, driver) {
  const shipment = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/status`, {
    method: 'PATCH',
    accessToken: driver.accessToken,
    body: { status, note: `Production smoke: ${status.toLowerCase().replace(/_/g, ' ')}.` },
  });
  console.log('OK shipment status', shipment.status);
  return shipment;
}

async function main() {
  if (!SHIPMENT_ID) throw new Error('Set SMOKE_SHIPMENT_ID to the funded, assigned shipment id.');
  console.log(`Tracko delivery smoke: ${API_BASE_URL}`);
  console.log(`Shipment: ${SHIPMENT_ID}`);

  const [customer, driver, admin] = await Promise.all([
    login('CUSTOMER', 'customer@tracko.ng'),
    login('DRIVER', 'driver@tracko.ng'),
    login('ADMIN', 'admin@tracko.ng'),
  ]);
  console.log('OK customer, driver and admin login');

  const assignments = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/assignments`, {
    accessToken: admin.accessToken,
  });
  let assignment = assignments.find((item) => ['OFFERED', 'ACCEPTED'].includes(item.status));
  if (!assignment) throw new Error('No active driver offer exists. Run npm run smoke:assignment first.');

  if (assignment.status === 'OFFERED') {
    assignment = await request(`/v1/shipments/assignments/${encodeURIComponent(assignment.id)}/accept`, {
      method: 'POST',
      accessToken: driver.accessToken,
    });
    console.log('OK driver accepted assignment', assignment.id);
  } else {
    console.log('OK accepted assignment reused', assignment.id);
  }

  let shipment = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}?role=DRIVER`, {
    accessToken: driver.accessToken,
  });
  const route = ['DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION'];
  const currentIndex = route.indexOf(shipment.status);
  if (currentIndex < 0 && !['DELIVERED', 'COMPLETED'].includes(shipment.status)) {
    throw new Error(`Shipment is ${shipment.status}; expected an accepted trip ready for execution.`);
  }
  if (currentIndex >= 0) {
    for (let index = Math.max(currentIndex + 1, 1); index < route.length; index += 1) {
      shipment = await updateStatus(route[index], driver);
    }
  }

  if (!['DELIVERED', 'COMPLETED'].includes(shipment.status)) {
    await request(`/v1/tracking/shipments/${encodeURIComponent(SHIPMENT_ID)}/location`, {
      method: 'POST',
      accessToken: driver.accessToken,
      body: {
        latitude: 6.4281,
        longitude: 3.4219,
        speedKph: 0,
        note: 'Driver arrived at the delivery location.',
      },
    });
    console.log('OK final driver location recorded');

    await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow/checks/arrivalConfirmed`, {
      method: 'POST',
      accessToken: driver.accessToken,
    });
    console.log('OK driver arrival confirmed');

    const proofs = await request(`/v1/tracking/shipments/${encodeURIComponent(SHIPMENT_ID)}/proof-of-delivery`, {
      accessToken: driver.accessToken,
    });
    if (!Array.isArray(proofs) || proofs.length === 0) {
      const proof = await request(`/v1/tracking/shipments/${encodeURIComponent(SHIPMENT_ID)}/proof-of-delivery`, {
        method: 'POST',
        accessToken: driver.accessToken,
        body: {
          recipientName: 'Tracko Test Receiver',
          note: 'Cargo received in good condition during the production workflow test.',
        },
      });
      console.log('OK proof of delivery submitted', proof.id);
    } else {
      console.log('OK existing proof of delivery reused', proofs[0].id);
    }
  } else {
    console.log('OK shipment already delivered');
  }

  for (const check of ['customerDeliveryConfirmed', 'disputeWindowClear']) {
    await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow/checks/${check}`, {
      method: 'POST',
      accessToken: customer.accessToken,
    });
    console.log('OK customer check', check);
  }
  await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow/checks/platformApproved`, {
    method: 'POST',
    accessToken: admin.accessToken,
  });
  console.log('OK admin platform approval');

  let escrow = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow`, {
    accessToken: admin.accessToken,
  });
  if (escrow.status !== 'RELEASED') {
    if (escrow.status !== 'RELEASE_READY') {
      throw new Error(`Escrow is ${escrow.status}; every release check did not reconcile.`);
    }
    escrow = await request(`/v1/shipments/${encodeURIComponent(SHIPMENT_ID)}/escrow/release`, {
      method: 'POST',
      accessToken: admin.accessToken,
      body: { note: 'Production test delivery confirmed; escrow approved for release.' },
    });
    console.log('OK admin released escrow', escrow.status);
  } else {
    console.log('OK escrow was already released');
  }

  const earnings = await request('/v1/driver/earnings', { accessToken: driver.accessToken });
  if (!earnings.availableBalance || earnings.availableBalance <= 0) {
    throw new Error('Driver earnings did not increase after escrow release.');
  }
  console.log('OK driver earnings available', earnings.availableBalanceLabel || earnings.availableBalance);
  console.log('DONE Tracko funded shipment completed through driver earnings');
}

main().catch((error) => {
  console.error('FAILED Tracko delivery smoke');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
