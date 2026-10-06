const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gates = require('./lib/native-release-gates');
const source = fs.readFileSync(path.join(__dirname, 'phase8-production-preflight.js'), 'utf8');
const certificate = Array(32).fill('AB').join(':');
const apple = { applinks: { details: [{ appIDs: ['ABCDE12345.com.trako.logistics'], components: [{ '/': '/mobile/*' }] }] } };
const android = [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.trako.logistics', sha256_cert_fingerprints: [certificate] } }];
function evidence() {
  return { platforms: Object.fromEntries(['android', 'ios'].map((platform) => [platform, {
    buildId: `${platform}-build`, physicalDevice: true, device: 'QA device', osVersion: 'Current OS', testedBy: 'QA reviewer', testedAt: new Date().toISOString(), tests: Object.fromEntries(gates.REQUIRED_TESTS.map((name) => [name, 'passed'])), blockers: [],
  }])) };
}

async function run(env = {}, options = {}) {
  const logs = [];
  const requests = [];
  const processStub = { env, exitCode: 0 };
  const moduleStub = { exports: {} };
  const fakeFetch = async (url, input) => {
    requests.push({ url, input });
    const pathname = new URL(url).pathname;
    const headers = { 'content-type': 'application/json', 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(self)', 'access-control-allow-origin': input.headers.Origin || '' };
    let data;
    if (pathname === '/v1/health') data = { ok: true, deployable: true, service: 'tracko-api', integrations: [{ name: 'kyc', productionReady: true }, { name: 'fatalErrorAlerts', mode: 'configured' }] };
    else if (pathname === '/v1/demo/readiness') data = { ok: true, escrowPayment: { paystackReady: true }, mapsAddressing: { provider: 'configured' }, kyc: { provider: 'configured' }, database: { connected: true }, email: { status: 'domain_verified' }, fileUploads: { status: 'ready', bucket: 'media' } };
    else if (pathname === '/v1/integrations/status') data = { payments: { mode: 'configured', provider: 'paystack' }, kyc: { realVerificationEnabled: true, productionReady: true, provider: 'smile_id' }, maps: { realRoutingEnabled: true, provider: 'google' }, translation: { multilingualTranscriptionEnabled: true, provider: 'google' } };
    else if (pathname.endsWith('/apple-app-site-association')) data = apple;
    else if (pathname.endsWith('/assetlinks.json')) data = android;
    else if (pathname.endsWith('.js')) { data = 'x'.repeat(100001); headers['content-type'] = 'application/javascript'; }
    else if (pathname.startsWith('/v1/legal/')) data = 'Published document '.repeat(20);
    else if (pathname.startsWith('/v1/auth/')) data = {};
    else { data = '<html><div id="root"></div><script src="/entry.js"></script></html>'; headers['content-type'] = 'text/html'; }
    const response = new Response(typeof data === 'string' ? data : JSON.stringify(data), { headers });
    Object.defineProperty(response, 'url', { value: pathname === '/' && options.redirectHost ? `https://${options.redirectHost}/` : url });
    return response;
  };
  const context = vm.createContext({
    process: processStub, module: moduleStub, URL, AbortSignal, fetch: fakeFetch,
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    require: (name) => {
      if (name === './lib/native-release-gates') return gates;
      if (name === 'node:fs') return { readFileSync: () => { if (options.invalidEvidence) return '{'; return JSON.stringify(options.evidence || evidence()); } };
      throw new Error(`Unexpected require ${name}`);
    },
  });
  vm.runInContext(source, context);
  await moduleStub.exports.main();
  return { logs: logs.join('\n'), requests, exitCode: processStub.exitCode };
}
const nativeEnv = (platform) => ({ RELEASE_PLATFORM: platform, PREFLIGHT_ACCESS_TOKEN: 'test-only-token', STRICT_PRODUCTION: 'true', APPLE_TEAM_ID: 'ABCDE12345', ANDROID_SHA256_CERT_FINGERPRINT: certificate, DEVICE_TEST_EVIDENCE_FILE: 'test-evidence.json', ANDROID_RELEASE_BUILD_ID: 'android-build', IOS_RELEASE_BUILD_ID: 'ios-build' });

test('web mode does not require physical-device evidence', async () => {
  const result = await run();
  assert.equal(result.exitCode, 0);
  assert.ok(!result.logs.includes('installed-device evidence'));
});
test('Android gate requires exact certificate and device record, not Apple membership', async () => {
  const env = nativeEnv('android'); delete env.APPLE_TEAM_ID;
  const result = await run(env);
  assert.equal(result.exitCode, 0);
  assert.match(result.logs, /OK   android installed-device evidence/);
  assert.ok(!result.requests.some((request) => request.url.endsWith('apple-app-site-association')));
  assert.ok(result.requests.every((request) => request.input.signal instanceof AbortSignal));
});
test('native mode blocks missing evidence even outside strict provider mode', async () => {
  const env = nativeEnv('android'); delete env.DEVICE_TEST_EVIDENCE_FILE; delete env.STRICT_PRODUCTION;
  const result = await run(env);
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /FAIL android installed-device evidence/);
});
test('iOS gate refuses missing or wrong Apple team', async () => {
  for (const team of ['', 'WRONG12345']) {
    const result = await run({ ...nativeEnv('ios'), APPLE_TEAM_ID: team });
    assert.equal(result.exitCode, 1);
    assert.match(result.logs, /FAIL Apple domain association/);
  }
});
test('all-platform gate validates each build independently', async () => {
  assert.equal((await run(nativeEnv('all'))).exitCode, 0);
  const data = evidence(); data.platforms.ios.buildId = 'old-build';
  const result = await run(nativeEnv('all'), { evidence: data });
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /different ios build/);
});
test('rejects wrong signing certificate and malformed evidence', async () => {
  assert.equal((await run({ ...nativeEnv('android'), ANDROID_SHA256_CERT_FINGERPRINT: Array(32).fill('CD').join(':') })).exitCode, 1);
  assert.equal((await run(nativeEnv('android'), { invalidEvidence: true })).exitCode, 1);
});
test('does not trust lookalike redirected hostnames', async () => {
  const result = await run({}, { redirectHost: 'eviltrako.com.ng' });
  assert.equal(result.exitCode, 1);
  assert.match(result.logs, /outside the Trako application hosts/);
});
test('rejects invalid platform and unsafe timeout configuration', async () => {
  await assert.rejects(run({ RELEASE_PLATFORM: 'unknown' }), /RELEASE_PLATFORM/);
  await assert.rejects(run({ PREFLIGHT_TIMEOUT_MS: 'invalid' }), /PREFLIGHT_TIMEOUT_MS/);
});
