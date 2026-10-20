# Paystack: switching from test to live

Drafted 20 October 2026 from the code on `main`. The API decides test or live only from the
secret key: `sk_live_...` is live, anything else is test (`payment-provider.service.ts`,
`status()`). The same key is used for charges, refunds (`/refund`), bank lookups and driver
payouts (`/transferrecipient`, `/transfer`). There is no separate payout key.

## Do not switch until

- [ ] Device checks pass on the release builds (TRACKO_ACCEPTANCE.md C1-C6, D4).
- [ ] In test mode, on the current API: `acceptance-live.js` all pass, `check:journey` and
      `check-exceptions.js` all pass (last run 20 October: 38/38, 20/20, 11/11).
- [ ] A backup restore drill within the last 30 days is recorded
      (`docs/backup-recovery-readiness.md`). The strict preflight refuses production without it.
- [ ] Paystack has activated the business for live payments (Paystack dashboard → Compliance:
      business details, director ID, bank account). Live keys only appear after activation.
- [ ] Owner sign-off on the refund and payout rules in the app (owner rules, 14 October).

## Paystack dashboard (live mode toggle on)

1. **Settings → API Keys & Webhooks**
   - Copy the **live secret key** (`sk_live_...`). Never paste it into the app, EAS or this repo.
   - **Live Webhook URL:** `https://trackoapi.vercel.app/v1/payments/webhooks/paystack/charge.success`
     (the same endpoint also receives `transfer.success`, `transfer.failed`, `transfer.reversed`).
   - Leave the callback URL empty: the API sends one with each payment (`PAYMENT_CALLBACK_URL`
     or the app's own origin, `resolveCallbackBaseUrl`).
2. **Settings → Preferences → Transfers:** turn **off** "Approve transfers with OTP". If it is on,
   every driver payout stops until someone types an OTP in the dashboard
   (`/v1/integrations/status` reports this as `payoutAutomation.otpRisk`).
3. **Balance:** payouts are paid from the Paystack balance. Keep enough in it to cover approved
   payouts. A transfer that fails or is reversed stays marked PAID in Trako; admins and the driver
   get a "did not complete" notification and the payout must be followed up by hand
   (`transfer.failed` handling in `payment-provider.service.ts`).

## Vercel (trackoapi project, Production environment)

1. Set `PAYSTACK_SECRET_KEY` to the live key. `PAYMENT_PROVIDER` stays `paystack`.
2. Redeploy the API.
3. Signed in as an admin, `GET /v1/integrations/status` must show
   `payments.environment: "live"` and `realChargeEnabled: true`.
4. Run the strict preflight with `STRICT_PRODUCTION=true`, `PREFLIGHT_ACCESS_TOKEN=<admin token>`,
   `BACKUP_RECOVERY_EVIDENCE_FILE` and `BACKUP_SOURCE_PROJECT_ID` set (plus the device evidence
   variables for a native release; see `docs/phase-8-launch-readiness.md`), then
   `node scripts/phase8-production-preflight.js`. PowerShell: set each with `$env:NAME="value"`.
   It must end with no failures.

From now on the scripted checks that move escrow refuse to run (`check:journey`,
`check-exceptions.js`, `acceptance-live.js`). That is intended: never run them against live.

## First live payment

1. The owner books one real shipment with their own card and the smallest real job available.
2. Check the Paystack dashboard shows the charge, the shipment shows "Funds held in escrow", and the
   admin finance screen shows it.
3. Either complete the delivery (payout to a real driver bank account) or cancel and refund it from
   admin. Paystack keeps its processing fee on a refund, and refunds take several working days to
   reach the card.
4. Record the result in TRACKO_ACCEPTANCE.md.

## Going back to test

Put the test key back in `PAYSTACK_SECRET_KEY` and redeploy. Live payments already made stay on the
Paystack dashboard and in the database; reconcile them by hand before resuming test runs.
