# Tracko Stakeholder Deployment Plan

## Recommended Setup

Use Vercel for the Expo web frontend. For this stakeholder preview, the NestJS backend can also be deployed on Vercel using the serverless API entry included in this repo.

This is the cleanest preview setup:

- Frontend: Vercel
- Backend API: Vercel for preview, Render/Railway later if you want a long-running Node service
- Database: Supabase Postgres
- Mobile preview: Expo LAN or later EAS build

## Frontend On Vercel

Vercel project settings:

```text
Framework Preset: Other
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

Frontend environment variables:

```text
EXPO_PUBLIC_API_BASE_URL=https://YOUR-BACKEND-VERCEL-URL
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Do not put backend secrets, Paystack secret keys, JWT secrets, or database URLs in the frontend.

## Backend On Vercel

This repo now includes:

```text
api/index.ts
vercel.json
```

Deploy the `tracko-api` folder as its own Vercel project.

Backend Vercel settings:

```text
Framework Preset: Other
Install Command: npm install
Build Command: npm run build
Output Directory: leave empty
```

Backend environment variables:

```text
NODE_ENV=production
DATABASE_URL=YOUR_SUPABASE_POOLER_DATABASE_URL
JWT_ACCESS_SECRET=LONG_RANDOM_SECRET
JWT_REFRESH_SECRET=LONG_RANDOM_SECRET
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
CORS_ORIGIN=https://YOUR-VERCEL-FRONTEND.vercel.app
ENABLE_PREVIEW_AUTH=true
MOCK_OTP_CODE=123456
EXPOSE_DEV_OTP=true
EMAIL_PROVIDER=mock
PAYMENT_PROVIDER=mock
KYC_PROVIDER=mock
```

Backend preview URLs:

```text
https://YOUR-BACKEND-VERCEL-URL/v1/health
https://YOUR-BACKEND-VERCEL-URL/v1/demo/readiness
https://YOUR-BACKEND-VERCEL-URL/v1/integrations/status
```

## Backend On Render Or Railway

Backend build command:

```text
npm install --no-audit --no-fund && npm run prisma:generate && npm run build
```

Backend start command:

```text
npm run start:prod
```

Backend health check:

```text
/v1/health
```

Backend environment variables:

```text
NODE_ENV=production
PORT=4000
DATABASE_URL=YOUR_SUPABASE_POOLER_DATABASE_URL
JWT_ACCESS_SECRET=LONG_RANDOM_SECRET
JWT_REFRESH_SECRET=LONG_RANDOM_SECRET
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=30d
CORS_ORIGIN=https://YOUR-VERCEL-FRONTEND.vercel.app
ENABLE_PREVIEW_AUTH=true
MOCK_OTP_CODE=123456
EXPOSE_DEV_OTP=true
EMAIL_PROVIDER=mock
PAYMENT_PROVIDER=mock
KYC_PROVIDER=mock
```

For a stakeholder demo, keep:

```text
ENABLE_PREVIEW_AUTH=true
PAYMENT_PROVIDER=mock
KYC_PROVIDER=mock
```

For production, change:

```text
ENABLE_PREVIEW_AUTH=false
EXPOSE_DEV_OTP=false
EMAIL_PROVIDER=resend
PAYMENT_PROVIDER=paystack
```

and add:

```text
RESEND_API_KEY=YOUR_RESEND_API_KEY
EMAIL_FROM=Tracko <verify@yourdomain.com>
PAYSTACK_SECRET_KEY=YOUR_PAYSTACK_SECRET_KEY
PAYMENT_CALLBACK_URL=https://YOUR-VERCEL-FRONTEND.vercel.app/customer/escrow
PAYMENT_FALLBACK_EMAIL=payments@yourdomain.com
```

## Auth Stage

Now completed:

- JWT access tokens
- Refresh token persistence
- Logout/revoke refresh token
- Account deletion
- Real password reset persistence
- Role-aware registration OTP request
- Email OTP provider switch, mock locally and Resend for production
- Production switch to disable preview login

Still needed before production:

- Verified sender/domain for email OTP
- SMS OTP provider if phone verification is required
- Rate limiting for login and OTP
- Admin staff creation policy
- Reviewer/test account notes for app stores

## Escrow Payment Stage

Now completed:

- Escrow records
- Mock escrow initialization
- Paystack transaction initialization when keys are present
- Paystack webhook signature check
- Paystack success webhook can mark escrow funded and update shipment timeline
- Escrow release, dispute, and refund controls are available
- Provider status endpoint

Still needed before live money:

- Paystack business account approval
- Real webhook URL configured in Paystack
- Finance ledger/reporting
- Legal review of escrow terms

## Preview Order

1. Deploy backend to Vercel from the `tracko-api` folder.
2. Confirm `https://YOUR-BACKEND/v1/health` works.
3. Run `scripts/apply-stakeholder-escrow-vercel-integration.ps1` against the frontend app folder.
4. Add backend URL to frontend Vercel as `EXPO_PUBLIC_API_BASE_URL`.
5. Deploy frontend to Vercel.
6. Test login, customer shipment, dispatcher assignment, driver accept, live trip, proof of delivery, customer tracking.
7. Share Vercel frontend URL with stakeholders.
