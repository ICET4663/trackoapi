# Tracko KYC MVP

The KYC MVP is designed to support real user trust checks before escrow/payment goes live.

## What Is Included

- Customer identity submission.
- Driver identity plus licence details.
- Truck owner identity plus vehicle/business document checklist.
- KYC submissions stored in Supabase.
- Admin verification queue.
- Admin review endpoint.
- Admin approve, request correction, and reject decisions.
- User verification status update after admin decision.

## User Statuses

The user account can show:

- `PENDING`
- `IN_REVIEW`
- `ACTION_NEEDED`
- `VERIFIED`
- `REJECTED`
- `SUSPENDED`

The KYC submission itself can show:

- `PENDING`
- `CORRECTION_REQUIRED`
- `APPROVED`
- `REJECTED`

## Backend Endpoints

```text
GET  /v1/kyc
POST /v1/kyc
GET  /v1/admin/verifications
GET  /v1/admin/verifications/:userId
POST /v1/admin/verifications/:userId
```

## Smoke Test

For local backend:

```powershell
npm run smoke:kyc
```

For deployed backend:

```powershell
$env:API_BASE_URL="https://trackoapi.vercel.app"
$env:ADMIN_ACCESS_TOKEN="paste-real-admin-or-dispatcher-access-token-here"
npm run smoke:kyc
```

If real email OTP is active and the script asks for an OTP, copy the code from the email and rerun:

```powershell
$env:API_BASE_URL="https://trackoapi.vercel.app"
$env:ADMIN_ACCESS_TOKEN="paste-real-admin-or-dispatcher-access-token-here"
$env:KYC_SMOKE_OTP="123456"
npm run smoke:kyc
```

The smoke test creates a customer, submits KYC, opens the admin queue, approves the submission, and confirms the user status.

Admin review endpoints now require a real admin or dispatcher login token in production. Local preview mode can still use the preview admin token for fast testing.

## MVP Boundary

This stage is manual-review KYC. It is enough for an MVP and stakeholder workflow demo.

Real provider integration comes later with providers such as:

- Smile Identity
- Dojah
- Mono

Those will require paid/provider keys and compliance review.
