const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAndroidAssociation, validateAppleAssociation, validateDeviceEvidence, REQUIRED_TESTS } = require('./native-release-gates');
const fingerprint = Array(32).fill('AB').join(':');
const android = [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'com.trako.logistics', sha256_cert_fingerprints: [fingerprint] } }];
const apple = { applinks: { details: [{ appIDs: ['ABCDE12345.com.trako.logistics'], components: [{ '/': '/mobile/*' }] }] } };
const now = Date.parse('2026-10-06T12:00:00Z');
const evidence = () => ({ platforms: { android: { buildId: 'build-1', physicalDevice: true, device: 'Test phone', osVersion: '15', testedBy: 'QA reviewer', testedAt: '2026-10-05T12:00:00Z', tests: Object.fromEntries(REQUIRED_TESTS.map((name) => [name, 'passed'])), blockers: [] } } });

test('accepts a matching Android signing certificate', () => assert.doesNotThrow(() => validateAndroidAssociation(android, fingerprint.toLowerCase())));
test('rejects missing, malformed and wrong Android certificates', () => {
  assert.throws(() => validateAndroidAssociation({}, fingerprint));
  assert.throws(() => validateAndroidAssociation(android, Array(20).fill('AB').join(':')), /SHA-256/);
  assert.throws(() => validateAndroidAssociation(android, Array(32).fill('CD').join(':')), /does not match/);
});
test('rejects another app package', () => assert.throws(() => validateAndroidAssociation([{ ...android[0], target: { ...android[0].target, package_name: 'other.app' } }], fingerprint)));
test('requires the correct Apple team and payment path', () => {
  assert.doesNotThrow(() => validateAppleAssociation(apple, 'ABCDE12345'));
  assert.throws(() => validateAppleAssociation(apple, 'WRONG12345'));
  assert.throws(() => validateAppleAssociation({ applinks: { details: [] } }));
});
test('accepts complete evidence only for the exact installed build', () => {
  assert.doesNotThrow(() => validateDeviceEvidence(evidence(), 'android', 'build-1', now));
  assert.throws(() => validateDeviceEvidence(evidence(), 'android', 'build-2', now));
});
test('rejects Expo Go/emulator evidence and untested capabilities', () => {
  const data = evidence(); data.platforms.android.physicalDevice = false;
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now));
  data.platforms.android.physicalDevice = true; data.platforms.android.tests.voiceMessaging = 'pending';
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now), /voiceMessaging/);
});
test('rejects stale/future evidence and unresolved blockers', () => {
  const data = evidence(); data.platforms.android.testedAt = '2026-09-01T00:00:00Z';
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now));
  data.platforms.android.testedAt = '2027-01-01T00:00:00Z';
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now));
  data.platforms.android.testedAt = '2026-10-05T12:00:00Z'; data.platforms.android.blockers = ['Payment return failed'];
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now), /blockers/);
});
test('requires all expected signing certificates during rotation', () => {
  const rotated = Array(32).fill('CD').join(':');
  assert.throws(() => validateAndroidAssociation(android, `${fingerprint},${rotated}`));
  const data = [{ ...android[0], target: { ...android[0].target, sha256_cert_fingerprints: [fingerprint, rotated] } }];
  assert.doesNotThrow(() => validateAndroidAssociation(data, `${fingerprint}, ${rotated}`));
});
test('rejects malformed relation, namespace and empty certificates', () => {
  assert.throws(() => validateAndroidAssociation([{ ...android[0], relation: android[0].relation[0] }], fingerprint));
  assert.throws(() => validateAndroidAssociation([{ ...android[0], target: { ...android[0].target, namespace: 'web' } }], fingerprint));
  assert.throws(() => validateAndroidAssociation([{ ...android[0], target: { ...android[0].target, sha256_cert_fingerprints: [] } }], fingerprint));
});
test('rejects malformed Apple arrays and excluded payment paths', () => {
  assert.throws(() => validateAppleAssociation({ applinks: { details: {} } }));
  assert.throws(() => validateAppleAssociation({ applinks: { details: [{ appIDs: apple.applinks.details[0].appIDs, components: [{ '/': '/mobile/*', exclude: true }] }] } }));
});
test('requires reviewer identity, device details and valid test date', () => {
  for (const [field, value] of [['testedBy', ''], ['device', ' '], ['osVersion', ''], ['testedAt', 'invalid']]) {
    const data = evidence(); data.platforms.android[field] = value;
    assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now));
  }
});
test('every required capability must pass and blockers must be explicit', () => {
  for (const name of REQUIRED_TESTS) {
    const data = evidence(); delete data.platforms.android.tests[name];
    assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now), new RegExp(name));
  }
  const data = evidence(); delete data.platforms.android.blockers;
  assert.throws(() => validateDeviceEvidence(data, 'android', 'build-1', now));
});
test('requires evidence for each exact platform and build', () => {
  assert.throws(() => validateDeviceEvidence(evidence(), 'ios', 'build-1', now), /missing for ios/);
  assert.throws(() => validateDeviceEvidence(evidence(), 'android', '', now), /RELEASE_BUILD_ID/);
});
