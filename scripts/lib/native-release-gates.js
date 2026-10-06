const PACKAGE = 'com.trako.logistics';
const FINGERPRINT = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/;
const REQUIRED_TESTS = ['authentication', 'roleNavigation', 'paystackReturn', 'voiceMessaging', 'cameraUploads', 'mapsLocation', 'notifications', 'shipmentLifecycle'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateAndroidAssociation(data, fingerprint) {
  const expected = (fingerprint || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  assert(expected.every((value) => FINGERPRINT.test(value)), 'Expected Android fingerprint must be SHA-256, not SHA-1.');
  assert(Array.isArray(data), 'Android association must be a JSON array.');
  const match = data.some((entry) => {
    const target = entry?.target;
    const certificates = target?.sha256_cert_fingerprints;
    return Array.isArray(entry?.relation) && entry.relation.includes('delegate_permission/common.handle_all_urls') &&
      target?.namespace === 'android_app' && target.package_name === PACKAGE &&
      Array.isArray(certificates) && certificates.length > 0 &&
      certificates.every((value) => typeof value === 'string' && FINGERPRINT.test(value)) &&
      expected.every((value) => certificates.includes(value));
  });
  assert(match, 'Android association does not match the Trako package and expected signing certificate.');
}

function validateAppleAssociation(data, teamId) {
  const expected = teamId?.trim().toUpperCase();
  if (expected) assert(/^[A-Z0-9]{10}$/.test(expected), 'Expected Apple Team ID must have 10 characters.');
  assert(Array.isArray(data?.applinks?.details) && data.applinks.details.some((entry) =>
    Array.isArray(entry?.appIDs) && entry.appIDs.some((id) =>
      typeof id === 'string' && (expected ? id === `${expected}.${PACKAGE}` : /^[A-Z0-9]{10}\.com\.trako\.logistics$/.test(id))) &&
    Array.isArray(entry.components) && entry.components.some((component) => component?.['/'] === '/mobile/*' && component.exclude !== true)),
  'Apple association does not match the Trako app identity and payment-return path.');
}

function validateDeviceEvidence(data, platform, expectedBuildId, now = Date.now()) {
  const result = data?.platforms?.[platform];
  assert(result, `Device evidence is missing for ${platform}.`);
  assert(typeof expectedBuildId === 'string' && expectedBuildId.trim(), `Set ${platform.toUpperCase()}_RELEASE_BUILD_ID to the EAS build being approved.`);
  assert(result.buildId === expectedBuildId, `Device evidence is for a different ${platform} build.`);
  assert(result.physicalDevice === true, 'Production sign-off needs a physical installed device, not Expo Go or an emulator.');
  assert(typeof result.device === 'string' && result.device.trim() && typeof result.osVersion === 'string' && result.osVersion.trim(), 'Record the device and OS version.');
  assert(typeof result.testedBy === 'string' && result.testedBy.trim(), 'Record who performed the installed-device tests.');
  const testedAt = Date.parse(result.testedAt);
  assert(Number.isFinite(testedAt) && testedAt <= now && now - testedAt <= 14 * 24 * 60 * 60 * 1000, 'Device evidence must be dated within the last 14 days.');
  for (const name of REQUIRED_TESTS) assert(result.tests?.[name] === 'passed', `${platform}: ${name} has not passed installed-device testing.`);
  assert(Array.isArray(result.blockers) && result.blockers.length === 0, `${platform} still has unresolved blockers.`);
}

module.exports = { validateAndroidAssociation, validateAppleAssociation, validateDeviceEvidence, REQUIRED_TESTS };
