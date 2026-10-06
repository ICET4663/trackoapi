# Production provider gates

These changes do not alter the app screens. Configuration presence is not proof of provider delivery or device readiness.

## Smile ID

Set these on the backend Vercel project (trackoapi), Production environment:

- KYC_PROVIDER=smile_id
- SMILE_ID_API_KEY: production key from your Smile ID account (keep private)
- SMILE_ID_PARTNER_ID: partner ID from the same account
- SMILE_ID_ENVIRONMENT=production
- SMILE_ID_CALLBACK_URL=https://trackoapi.vercel.app

Register https://trackoapi.vercel.app/v1/kyc/provider/webhooks/smile_id/verification.completed with Smile ID. Ensure the account is approved and its wallet has sufficient balance. Redeploy the backend. Check authenticated /v1/integrations/status: kyc.productionReady must be true. Submit a consented test identity and confirm a signed callback updates the intended submission. Do not enable demo bootstrap or use demo approvals as evidence of real KYC.

Unsupported document types still require manual review. Dojah/Mono keys alone do not enable an implemented verification adapter.

## Fatal-error alerts

Choose one backend Production configuration:

- TELEMETRY_ALERT_WEBHOOK_URL: operations-owned HTTPS webhook; or
- TELEMETRY_ALERT_EMAIL: operations-owned recipient, with RESEND_API_KEY and EMAIL_FROM set to a verified sending-domain address, for example Trako <alerts@updates.trako.com.ng>.

Both channels can be enabled. Notifications are deduplicated per error fingerprint for 15 minutes. Channel failures never break the application error sink. Alert emails omit stacks and actor IDs; authorized admins can inspect the full audit record. Do not put API keys in frontend/EAS public variables.

After redeployment, health should report fatalErrorAlerts configured. With the operations recipient's approval, submit one clearly labelled synthetic fatal error and verify receipt; check that a repeat does not flood the inbox. Configured status alone is not delivery confirmation.

## Apple association and native QA

In the web Vercel project, set APPLE_TEAM_ID to the real 10-character membership Team ID. Web builds now generate public/.well-known/apple-app-site-association automatically. Set REQUIRE_IOS_ASSOCIATION=true once ready to enforce this gate during subsequent builds. Never commit a guessed Team ID or an empty association file.

Verify https://www.trako.com.ng/.well-known/apple-app-site-association returns 200 JSON without a redirect, with TEAM_ID.com.trako.logistics and /mobile/* in its applinks details. Native callbacks/entitlements use www because the apex domain redirects. This requires rebuilding native apps; older installed builds retain the old entitlements.

Run STRICT_PRODUCTION=true npm run smoke:production (PowerShell: $env:STRICT_PRODUCTION='true'). An authenticated PREFLIGHT_ACCESS_TOKEN enables protected provider diagnostics. This smoke does not perform payments, real KYC submissions, or email sends.

Installed-build sign-off is still mandatory: customer OTP/login, funded shipment, assignment/driver acceptance, microphone/transcription across two devices, camera/upload evidence, maps/GPS, notification receipt, delivery confirmation/release/payout and Paystack return to the same signed-in customer. Record build IDs, OS versions, results and blockers. Do not label either store build production-ready until these checks pass.
