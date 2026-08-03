const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return data;
}

async function registerCustomer() {
  const suffix = Date.now();
  const email = `kyc.customer.${suffix}@tracko.test`;
  const phone = `+23481${String(suffix).slice(-8)}`;
  const password = 'password123';
  const role = 'CUSTOMER';

  const otp = await request('/v1/auth/register/request', {
    method: 'POST',
    body: JSON.stringify({ email, phone, role }),
  });

  const code = otp.devCode || process.env.KYC_SMOKE_OTP || process.env.MOCK_OTP_CODE || '123456';
  if (!otp.devCode && !process.env.KYC_SMOKE_OTP && API_BASE_URL.startsWith('https://')) {
    throw new Error('Real email OTP is enabled. Set KYC_SMOKE_OTP to the code received by email, then rerun this script.');
  }

  const session = await request('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      phone,
      fullName: 'KYC Smoke Customer',
      password,
      code,
      role,
    }),
  });

  if (!session.accessToken || !session.user?.id) {
    throw new Error('KYC smoke registration did not return a signed-in user.');
  }

  return session;
}

async function main() {
  console.log(`Tracko KYC smoke: ${API_BASE_URL}`);

  const health = await request('/v1/health');
  console.log('OK health', health.service || 'tracko-api');

  const session = await registerCustomer();
  console.log('OK registered customer', session.user.email);

  const submitted = await request('/v1/kyc', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      role: 'CUSTOMER',
      idType: 'NIN',
      idNumber: '12345678901',
      bvn: '12345678901',
      documents: [
        {
          type: 'ID_FRONT',
          label: 'Government ID photo',
          url: 'preview://smoke/id-front',
        },
        {
          type: 'SELFIE',
          label: 'Selfie',
          url: 'preview://smoke/selfie',
        },
      ],
    }),
  });
  console.log('OK KYC submitted', submitted.status);

  const myKyc = await request('/v1/kyc', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  console.log('OK KYC status', myKyc.submission?.status || myKyc.verificationStatus);

  const queue = await request('/v1/admin/verifications');
  const entry = queue.find((item) => item.userId === session.user.id) || queue[0];
  if (!entry) throw new Error('Admin verification queue is empty after KYC submission.');
  console.log('OK admin queue', entry.status, entry.role);

  const review = await request(`/v1/admin/verifications/${encodeURIComponent(entry.userId)}`);
  if (!review.submission?.id) throw new Error('Admin KYC review did not return a submission.');
  console.log('OK admin review', review.user?.email || entry.userId);

  const decision = await request(`/v1/admin/verifications/${encodeURIComponent(entry.userId)}`, {
    method: 'POST',
    body: JSON.stringify({ action: 'APPROVE', note: 'Smoke test approval.' }),
  });
  console.log('OK admin approved', decision.status);

  const verified = await request('/v1/auth/me', {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  console.log('OK user verification status', verified.verificationStatus);

  console.log('DONE Tracko KYC smoke passed');
}

main().catch((error) => {
  console.error('FAILED Tracko KYC smoke');
  console.error(error.message || error);
  process.exit(1);
});
