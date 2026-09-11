# Tracko Phase 8 Launch Readiness

Phase 7 is code-complete for the web MVP. Phase 8 validates the deployed system,
activates production providers, tests native devices, and prepares store releases.

## Automated release gate

Run the read-only production preflight after every frontend or backend deployment:

```powershell
cd "C:\Users\hp\Desktop\trackoapi-clean"
npm run smoke:production
```

The command checks the custom domain, API health, CORS, Paystack configuration,
Google routing, database connectivity, the verified Resend domain, Supabase
Storage, and published legal documents. It reports automated KYC and multilingual
voice as advisories until those paid providers are active.

Set `PREFLIGHT_ACCESS_TOKEN` to a current admin access token when you also want
the preflight to inspect the protected detailed provider status endpoint.

To make advisories fail a release candidate:

```powershell
$env:STRICT_PRODUCTION="true"
npm run smoke:production
```

The preflight never logs in, creates shipments, charges a card, or changes live
data. The authenticated workflow smoke tests remain separate.

## Required manual validation

- Register a new customer with a real email and complete OTP verification.
- Submit KYC documents and approve, correct, and reject them from operations.
- Create a shipment with real addresses, cargo dimensions, and truck fit.
- Fund escrow using a Paystack test card and verify both redirect and webhook paths.
- Approve the shipment, assign an eligible verified truck and driver, and accept it.
- Confirm pickup, live tracking, proof of delivery, customer confirmation, release,
  driver earnings, withdrawal request, and admin payout approval.
- Open a dispute and verify escrow remains locked through resolution/refund.
- Send text, attachment, and voice messages between customer, driver, owner, and
  operations roles.

## Native release gates

- Build the Expo `preview` profile for Android and iOS.
- Test maps, camera, photo library, microphone, transcription, notifications,
  safe areas, keyboard handling, deep links, and payment return links on devices.
- Test at least one low- or mid-range Android phone and one physical iPhone.
- Record failures with device model, OS version, app build, account role, and steps.

## Provider activation gates

- Keep Paystack test keys until the full money workflow and reconciliation are green.
- Connect and secure one paid KYC provider before production identity claims.
- Confirm Resend sends OTP to addresses outside the account owner's inbox.
- Confirm Google Routes, Places, Geocoding, Translation, and Speech quotas and key
  restrictions match the deployed frontend/backend usage.
- Configure Expo push credentials for Android and iOS store builds.

## Launch decision

Do not switch Paystack to live keys or submit to stores until the automated
preflight, authenticated workflow test, native device matrix, security review,
privacy/legal review, database backup restore test, and monitoring alerts all pass.
