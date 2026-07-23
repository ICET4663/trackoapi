# Tracko API Stakeholder Demo

Use this page to show that the backend is connected and the app is ready to start using authentication, escrow, and KYC flows.

## Main Demo URL

Open:

```text
http://localhost:4000/v1/demo/readiness
```

When deployed:

```text
https://YOUR-BACKEND-URL/v1/demo/readiness
```

What this proves:

- API is running.
- API can connect to Supabase/Postgres.
- Auth endpoints are ready.
- Escrow payment endpoint is ready.
- Escrow can be released, disputed, or refunded by platform rules.
- KYC endpoint is ready.
- Frontend can connect once `EXPO_PUBLIC_API_BASE_URL` points to the backend.

## Supporting URLs

```text
http://localhost:4000/v1/health
http://localhost:4000/v1/integrations/status
http://localhost:4000/v1/legal/privacy
http://localhost:4000/v1/legal/terms
http://localhost:4000/v1/legal/account-deletion
```

## Escrow Lifecycle Endpoints

```text
POST /v1/payments/escrow/initialize
GET /v1/shipments/:id/escrow
POST /v1/shipments/:id/escrow/checks/:check
POST /v1/shipments/:id/escrow/release
POST /v1/shipments/:id/escrow/dispute
POST /v1/shipments/:id/escrow/refund
```

## Frontend Connection

In the Expo/Vercel frontend environment, set:

```text
EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-URL/v1
```

For local preview:

```text
EXPO_PUBLIC_API_BASE_URL=http://localhost:4000/v1
```

## What To Say In The Demo

The current application has a connected backend API with Supabase/Postgres, role-based authentication endpoints, email OTP readiness with rate limiting, escrow payment provider readiness through Paystack, escrow release/dispute/refund controls, and KYC provider readiness. The live money and real identity checks remain switched off until provider accounts and production keys are approved.

## What Is Still Needed For Production

- Deploy backend to Render or Railway.
- Deploy frontend to Vercel.
- Add backend URL to frontend env.
- Add real email provider key.
- Add Paystack business secret key.
- Add KYC provider key.
- Configure webhooks for Paystack and KYC provider.
- Turn off preview auth before production launch.
