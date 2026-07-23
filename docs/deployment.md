# Tracko API Deployment

The backend can be deployed to Render, Railway, Fly.io, or any Node.js hosting
service. Render and Railway config examples are included in this folder.

## Required Environment Variables

Set these before production startup:

```text
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=<long-random-secret>
JWT_REFRESH_SECRET=<long-random-secret>
CORS_ORIGIN=https://your-mobile-web-domain.netlify.app,https://your-vercel-domain.vercel.app
```

Optional provider variables can stay empty until live integrations begin:

```text
PAYMENT_PROVIDER=mock
PAYSTACK_SECRET_KEY=
STRIPE_SECRET_KEY=
KYC_PROVIDER=mock
SMILE_ID_API_KEY=
SMILE_ID_PARTNER_ID=
DOJAH_API_KEY=
DOJAH_APP_ID=
MONO_SECRET_KEY=
GOOGLE_MAPS_API_KEY=
```

## Build Commands

```text
npm install --no-audit --no-fund
npm run prisma:generate
npm run build
```

## Start Command

```text
npm run start:prod
```

## Health Check

```text
GET /v1/health
```

The response includes:

- required environment status
- integration mock/configured status
- whether the API is deployable

## Mobile App Environment

After backend deployment, update the Expo app:

```text
EXPO_PUBLIC_API_BASE_URL=https://your-backend-domain.com
```

Then rebuild or redeploy the mobile web preview so the new API URL is bundled
into the frontend.

## Supabase SQL Order

Run these in Supabase SQL editor in order:

```text
supabase/base-schema.sql
supabase/backend-stage-two.sql
supabase/backend-stage-three.sql
supabase/demo-seed.sql
supabase/check-readiness.sql
```

Then run seed data locally only if you want demo accounts:

```text
npm run db:seed
```
