# Tracko Auth, Escrow, And KYC Integration

## What Is Now Integrated

Authentication:

- Registration OTP request is role-aware.
- Customer, driver, and truck owner self-registration require OTP.
- OTP can be delivered through email when `EMAIL_PROVIDER=resend`.
- Password reset updates the real password and revokes old refresh tokens.
- Preview login can be disabled with `ENABLE_PREVIEW_AUTH=false`.
- OTP can be hidden in production with `EXPOSE_DEV_OTP=false`.

Escrow payment:

- Escrow initialization supports Paystack when `PAYMENT_PROVIDER=paystack`.
- Paystack initialization returns an `authorizationUrl`.
- Paystack webhook signature is checked with `x-paystack-signature`.
- Verified Paystack success webhook marks escrow as `FUNDED`.
- The shipment timeline is updated to `ESCROW_FUNDED`.
- Escrow release requires all delivery/platform checks to pass.
- Escrow can be disputed or refunded by allowed roles.

KYC:

- KYC submission is persisted.
- Admin approval/rejection updates the user's verification status.
- Provider webhook can update KYC submission status.
- Provider webhook can update the user's verification status.

## Backend Environment Variables

For preview:

```text
ENABLE_PREVIEW_AUTH=true
EXPOSE_DEV_OTP=true
EMAIL_PROVIDER=mock
PAYMENT_PROVIDER=mock
KYC_PROVIDER=mock
```

For production email OTP:

```text
ENABLE_PREVIEW_AUTH=false
EXPOSE_DEV_OTP=false
EMAIL_PROVIDER=resend
RESEND_API_KEY=YOUR_RESEND_API_KEY
EMAIL_FROM=Tracko <verify@yourdomain.com>
```

For Paystack escrow:

```text
PAYMENT_PROVIDER=paystack
PAYSTACK_SECRET_KEY=YOUR_PAYSTACK_SECRET_KEY
PAYMENT_CALLBACK_URL=https://YOUR-FRONTEND/customer/escrow
PAYMENT_FALLBACK_EMAIL=payments@yourdomain.com
```

For KYC provider mode:

```text
KYC_PROVIDER=dojah
DOJAH_API_KEY=YOUR_DOJAH_API_KEY
DOJAH_APP_ID=YOUR_DOJAH_APP_ID
KYC_PROVIDER_REDIRECT_URL=https://YOUR-FRONTEND/customer/kyc
```

## Mobile Patch

Run this once in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api\scripts\apply-auth-escrow-kyc-mobile-integration.ps1"
```

Then restart Expo:

```powershell
cd "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"
npx expo start --lan --clear
```

## Provider Accounts Needed

- Email OTP: Resend account or another transactional email provider.
- Escrow: Paystack business account.
- KYC: Dojah, Smile ID, Mono, or similar provider.

No real money or real identity checks should run until the provider accounts, webhook URLs, legal terms, and production secrets are ready.
