const API_BASE_URL = (process.env.API_BASE_URL || 'https://trackoapi.vercel.app').replace(/\/$/, '');
const APP_URL = (process.env.APP_URL || 'https://trako.com.ng').replace(/\/$/, '');
const STRICT_PRODUCTION = process.env.STRICT_PRODUCTION === 'true';
const REQUEST_TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS || 12000);
const PREFLIGHT_ACCESS_TOKEN = process.env.PREFLIGHT_ACCESS_TOKEN;

const results = [];

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Tracko-Phase8-Preflight/1.0',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function json(path) {
  const response = await request(`${API_BASE_URL}${path}`, PREFLIGHT_ACCESS_TOKEN && path === '/v1/integrations/status'
    ? { headers: { Authorization: `Bearer ${PREFLIGHT_ACCESS_TOKEN}` } }
    : undefined);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Expected JSON but the API returned another response type.');
  }
}

async function check(label, level, task) {
  try {
    const detail = await task();
    results.push({ label, level, ok: true, detail });
    console.log(`OK   ${label}${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ label, level, ok: false, detail });
    console.log(`${level === 'required' ? 'FAIL' : 'WARN'} ${label} - ${detail}`);
  }
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log('Tracko Phase 8 production preflight');
  console.log(`App: ${APP_URL}`);
  console.log(`API: ${API_BASE_URL}`);

  await check('custom domain', 'required', async () => {
    const response = await request(APP_URL);
    requireValue(response.ok, `HTTP ${response.status}`);
    requireValue(new URL(response.url).hostname.endsWith('trako.com.ng'), `redirected to ${response.url}`);
    return `HTTP ${response.status}`;
  });

  await check('API health', 'required', async () => {
    const health = await json('/v1/health');
    requireValue(health.ok === true, 'health response did not report ok=true');
    requireValue(health.deployable === true, `missing required configuration: ${(health.required?.missing || []).join(', ')}`);
    return `${health.service}; deployable`;
  });

  await check('frontend CORS', 'required', async () => {
    const response = await request(`${API_BASE_URL}/v1/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: APP_URL,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    requireValue(response.ok || response.status === 204, `preflight returned HTTP ${response.status}`);
    const allowedOrigin = response.headers.get('access-control-allow-origin');
    requireValue(allowedOrigin === APP_URL || allowedOrigin === '*', `allowed origin is ${allowedOrigin || 'missing'}`);
    return allowedOrigin;
  });

  let integrations;
  let readiness;
  await check('deployment readiness', 'required', async () => {
    readiness = await json('/v1/demo/readiness');
    requireValue(readiness?.ok === true, readiness?.message || 'deployment readiness failed');
    return 'available';
  });

  await check('detailed provider status', 'advisory', async () => {
    requireValue(PREFLIGHT_ACCESS_TOKEN, 'set PREFLIGHT_ACCESS_TOKEN to inspect protected provider details');
    integrations = await json('/v1/integrations/status');
    requireValue(integrations?.payments && integrations?.kyc && integrations?.maps, 'provider status is incomplete');
    return 'authenticated check passed';
  });

  await check('Paystack', 'required', async () => {
    const configured = integrations?.payments?.mode === 'configured' || readiness?.escrowPayment?.paystackReady === true;
    requireValue(configured, 'payment provider is not configured');
    return integrations?.payments
      ? `${integrations.payments.provider} ${integrations.payments.environment || ''}`.trim()
      : 'configured';
  });

  await check('maps and routing', 'required', async () => {
    const configured = integrations?.maps?.realRoutingEnabled === true || readiness?.mapsAddressing?.provider === 'configured';
    requireValue(configured, 'Google maps provider is not configured');
    return integrations?.maps?.provider || readiness.mapsAddressing.provider;
  });

  await check('automated KYC provider', 'advisory', async () => {
    const configured = integrations?.kyc?.realVerificationEnabled === true || readiness?.kyc?.provider === 'configured';
    requireValue(configured, 'manual review is active; paid identity verification is not connected');
    return integrations?.kyc?.provider || readiness.kyc.provider;
  });

  await check('multilingual voice', 'advisory', async () => {
    requireValue(PREFLIGHT_ACCESS_TOKEN, 'set PREFLIGHT_ACCESS_TOKEN to inspect protected voice provider details');
    requireValue(integrations?.translation?.multilingualTranscriptionEnabled === true, 'multilingual transcription credentials are incomplete');
    return integrations.translation.provider;
  });

  await check('database, email, and storage', 'required', async () => {
    requireValue(readiness.database?.connected === true, readiness.database?.error || 'database is not connected');
    requireValue(readiness.email?.status === 'domain_verified', readiness.email?.message || 'email domain is not verified');
    requireValue(readiness.fileUploads?.status === 'ready', readiness.fileUploads?.message || 'persistent uploads are not ready');
    return `${readiness.email.verifiedDomains?.join(', ') || 'email verified'}; ${readiness.fileUploads.bucket}`;
  });

  for (const document of ['privacy', 'terms', 'account-deletion']) {
    await check(`legal page: ${document}`, 'required', async () => {
      const response = await request(`${API_BASE_URL}/v1/legal/${document}`);
      requireValue(response.ok, `HTTP ${response.status}`);
      const text = await response.text();
      requireValue(text.length > 100, 'document content is unexpectedly short');
      return 'published';
    });
  }

  const requiredFailures = results.filter((result) => result.level === 'required' && !result.ok);
  const advisories = results.filter((result) => result.level === 'advisory' && !result.ok);
  console.log('');
  console.log(`SUMMARY ${results.filter((result) => result.ok).length}/${results.length} checks passed`);
  console.log(`Required failures: ${requiredFailures.length}; advisories: ${advisories.length}`);

  if (requiredFailures.length || (STRICT_PRODUCTION && advisories.length)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('FAILED Tracko Phase 8 production preflight');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
