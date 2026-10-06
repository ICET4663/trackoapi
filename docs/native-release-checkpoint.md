# Native release checkpoint

The preflight can now target web, android, ios or all using RELEASE_PLATFORM. Default web behavior remains compatible. Selecting android skips the Apple association check; selecting ios skips Android association. Provider checks still apply to both. No screens, credentials or hosting integrations are changed.

## Record real device evidence

Start from device-test-evidence.example.json and keep the completed record outside Git: device model, OS, EAS build ID, test date, testedBy reviewer identity, results and unresolved blockers. Never add passwords, tokens, real identity documents, bank details or private chat recordings. Mark tests passed only after observing the installed build. The validator checks the record, not the device itself: this is a release guard, not automatic proof of quality.

Required scenarios:

1. Authentication: new email OTP registration, login, logout, expired-session recovery.
2. Role navigation: customer, driver, owner and operations workflows; forbidden screens remain inaccessible.
3. Paystack return: successful test payment returns to the same signed-in customer and correct shipment; abandoned/failed payment does not fund escrow; repeated verification is safe.
4. Voice messaging: two separate accounts/devices exchange text and audio; English, Yoruba, Igbo and Hausa recordings reach the recipient with the expected original transcript and English translation; denied microphone permission and failed uploads can recover.
5. Camera/uploads: pickup and delivery evidence persist and can be viewed by authorized customer/operations users, not unrelated users.
6. Maps/location: permission prompt, denial/retry, accurate pickup/dropoff search and selection, active-trip GPS updates on the other device. Background/suspended behavior must match the feature promised to users.
7. Notifications: permission denied/granted, installed-build delivery and routing to the correct authorized screen; no cross-account notification leakage after logout.
8. Shipment lifecycle: funding, admin review, assignment, negotiation, acceptance, pickup proof, arrival, delivery proof, customer confirmation/dispute, release, earnings and payout review. A disputed shipment must not release funds.

Record the exact EAS build ID, physicalDevice=true only for real hardware, testedAt as an ISO timestamp and each result as passed only after verification. Evidence older than 14 days, evidence for a different build, missing results or unresolved blockers stops release approval. Expo Go and emulators are useful development checks but cannot satisfy physical installed-build sign-off.

## Run an Android checkpoint (PowerShell)

```powershell
$env:RELEASE_PLATFORM = 'android'
$env:STRICT_PRODUCTION = 'true'
$env:ANDROID_SHA256_CERT_FINGERPRINT = 'YOUR_BUILD_SIGNING_SHA256'
$env:ANDROID_RELEASE_BUILD_ID = 'YOUR_EAS_BUILD_ID'
$env:DEVICE_TEST_EVIDENCE_FILE = 'C:\path\device-test-evidence.json'
node scripts/phase8-production-preflight.js
```

For Google Play distribution, compare with the Play App Signing certificate, not only the preview-upload certificate. Both may be listed when both installation channels are supported.

For iOS use RELEASE_PLATFORM=ios, APPLE_TEAM_ID and IOS_RELEASE_BUILD_ID instead of the Android values. Apple membership and a real installed build are still required. Use RELEASE_PLATFORM=all only when both platforms have been tested. Clear these PowerShell variables before returning to a web-only check.

Run the validator and preflight regression tests with npm run test:release-gates. This command performs no payments, emails, provider submissions, store uploads or hosting changes. Selecting a native platform makes its association and device record required even without STRICT_PRODUCTION. Use strict mode for final provider sign-off as well.
