# Tracko API

Local NestJS backend for the Tracko logistics app.

## Stack

- NestJS
- PostgreSQL
- Prisma
- JWT auth
- Mock OTP (`123456` by default)

## First Run

```powershell
npm install
copy .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run start:dev
```

API base URL:

```text
http://localhost:4000/v1
```

Open these URLs in the browser to view the backend:

```text
http://localhost:4000/v1/health
http://localhost:4000/v1/legal/privacy
http://localhost:4000/v1/legal/terms
http://localhost:4000/v1/legal/account-deletion
http://localhost:4000/v1/integrations/status
```

Mobile app env:

```text
EXPO_PUBLIC_API_BASE_URL=http://localhost:4000
```

Sample login users after seeding:

```text
customer@tracko.ng / password123
driver@tracko.ng / password123
truckowner@tracko.ng / password123
dispatcher@tracko.ng / password123
admin@tracko.ng / password123
```

## Supabase Setup

Create a free Supabase project, copy the Postgres connection string, and set it as `DATABASE_URL` in `.env`.

For local-only development with Docker instead:

```powershell
docker compose up -d
```

Then use this `.env` database URL:

```text
DATABASE_URL="postgresql://tracko:tracko_dev_password@localhost:5432/tracko?schema=public"
```

## Current Scope

- Health check
- User registration request with mock OTP
- User registration
- Login
- Refresh token
- Current user
- Logout
- Account deletion
- Privacy policy page
- Terms page
- External account deletion page
- Customer portal endpoint
- Driver portal endpoint
- Truck owner portal endpoint
- Generic data collection endpoints for the mobile app
- Shipment endpoints
- Conversation/message endpoints
- Voice transcription placeholder endpoint
- Push notification token registration placeholder endpoint
- Media upload placeholder endpoint
- Dispatcher driver assignment workflow
- Driver assignment accept/reject workflow
- Escrow initialization placeholder endpoint
- Provider status endpoint for KYC, payments, and maps
- Operations dashboard endpoint
- Operations shipment progress endpoint
- Dispute create/resolve placeholders
- Support ticket placeholder
- Live tracking location endpoints
- Proof of delivery endpoints
- In-app notification endpoints
- Push token persistence endpoint

See `docs/api-phase-1.md` for request examples.

Payments, real KYC, paid maps, and SMS are still intentionally deferred from live use. The backend now has provider-ready endpoints and environment variables, but it stays in mock mode until real provider keys are added.

## Deployment

See `docs/deployment.md` for Render/Railway deployment settings, required
environment variables, and mobile app API URL setup.

## Full Preview

See `docs/full-preview.md` for the complete local workflow preview order,
including the backend smoke test and Expo app steps.

## Integration Readiness

Preview status:

```text
GET /v1/integrations/status
```

Dispatcher and driver workflow:

```text
GET /v1/shipments/dispatch/available-drivers
POST /v1/shipments/:id/assignments
GET /v1/shipments/:id/assignments
POST /v1/shipments/assignments/:assignmentId/accept
POST /v1/shipments/assignments/:assignmentId/reject
```

Provider-ready endpoints:

```text
POST /v1/payments/escrow/initialize
POST /v1/payments/webhooks/:provider/:event
POST /v1/kyc/provider/initiate
POST /v1/kyc/provider/webhooks/:provider/:event
```

Operations workflow endpoints:

```text
GET /v1/operations/dashboard
POST /v1/operations/shipments/:id/progress
POST /v1/operations/disputes
PATCH /v1/operations/disputes/:id/resolve
POST /v1/operations/support/tickets
```

Tracking and delivery proof endpoints:

```text
GET /v1/tracking/shipments/:id
GET /v1/tracking/shipments/:id/history
POST /v1/tracking/shipments/:id/location
GET /v1/tracking/shipments/:id/proof-of-delivery
POST /v1/tracking/shipments/:id/proof-of-delivery
```

Notification endpoints:

```text
GET /v1/notifications
GET /v1/notifications/unread-count
PATCH /v1/notifications/:id/read
POST /v1/notifications/mark-all-read
POST /v1/notifications/push-token
```

## Store Review Readiness Notes

The backend now has the first required compliance endpoints:

```text
GET /v1/legal/privacy
GET /v1/legal/terms
GET /v1/legal/account-deletion
DELETE /v1/auth/account
```

Before App Store or Google Play submission, replace the placeholder support email
and company details in `src/legal/legal.controller.ts` with the real business
information. Google Play also requires the external account deletion URL in Play
Console. Apple requires the in-app delete account flow to be easy to find.
