# Trako security hardening report - 2026-09-28

## Controls verified

- JWT access and refresh sessions, role guards, CORS allow-listing and security headers are active.
- Express framework disclosure is disabled.
- Authentication, OTP, maps, client-error reporting and paid provider entry points are rate-limited.
- Google Maps proxy limits are keyed by authenticated user, so one account cannot consume another account's allowance.
- Payment and KYC webhooks validate provider signatures before changing state.
- Paystack payout release includes beneficiary-name matching and audit records.
- Smile ID Enhanced KYC is asynchronous, signature-checked and falls back to manual review when unavailable.
- Fatal client errors can notify an operations webhook through `TELEMETRY_ALERT_WEBHOOK_URL`; duplicate signatures are suppressed for 15 minutes.
- Viewing the admin client-error log now creates a `CLIENT_ERROR_LOG_VIEWED` audit entry.

## Audit-log coverage reviewed

Audit records cover authentication/session changes, OTP email delivery failures, KYC submissions and provider callbacks, payment and payout webhooks, shipment and assignment changes, administrative settings, user/account decisions, document review, vehicle expenses, support actions and telemetry access.

High-volume read-only map, list and dashboard requests are not written to the audit log. They are authenticated and rate-limited instead. This avoids turning normal navigation into an unbounded audit table while preserving records for state-changing and sensitive administrative actions.

## Privacy and provider disclosure

The public and in-app privacy policy now names Smile ID and states which identity fields are sent for an automated Nigerian ID check. The KYC form repeats this notice before submission. The policy remains product copy and still requires qualified Nigerian privacy/legal review before production launch.

## Frontend dependency audit

`npm audit --omit=dev` reports 111 transitive findings: 80 high, 31 moderate and 0 critical. They are inherited through the Expo 54 / React Native / Metro build and development graph. npm reports no compatible direct fix for the affected Expo and React Native packages in the current SDK. The installed dependency tree is valid, Expo's offline compatibility check reports dependencies up to date, TypeScript passes and the production web export succeeds.

Do not use `npm audit fix --force`: it would move core Expo/React Native packages outside their supported SDK set. Re-run the audit during the planned Expo SDK upgrade and adopt patched versions through `npx expo install`, followed by native device regression testing.

## Deployment configuration

Set `TELEMETRY_ALERT_WEBHOOK_URL` to an HTTPS endpoint owned by operations if immediate fatal-error alerts are required. Without it, errors remain available in the authenticated admin error console and server logs.

