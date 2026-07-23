# Backend Stage 2

Implemented in this stage:

- Auth foundation remains active: mock OTP, register, login, refresh, logout, current user.
- Account deletion endpoint for store compliance.
- Public privacy, terms, and account deletion pages.
- Customer, driver, and truck owner portal endpoints.
- Generic data endpoints used by the mobile app.
- Shipment create/list/detail/status endpoints.
- Conversation/message/typing endpoints.
- Voice transcription placeholder endpoint.
- Push token registration placeholder endpoint.
- Media upload placeholder endpoint.
- Node 22 guidance via `.nvmrc` and package `engines`.
- Local startup helper: `scripts/start-local.ps1`.

## Endpoints Added

```http
GET /v1/customer/portal
GET /v1/driver/portal
GET /v1/owner/portal
```

```http
GET /v1/data/:collection
GET /v1/data/:collection/:id
POST /v1/data/:collection
```

```http
POST /v1/shipments
GET /v1/shipments
GET /v1/shipments/:id
PATCH /v1/shipments/:id/status
```

```http
GET /v1/conversations?role=CUSTOMER
GET /v1/conversations/:conversationId/messages
POST /v1/conversations/:conversationId/messages
POST /v1/conversations/:conversationId/typing
POST /v1/voice/transcriptions
POST /v1/notifications/push-token
POST /v1/media/upload
```

```http
DELETE /v1/auth/account
```

```http
GET /v1/legal/privacy
GET /v1/legal/terms
GET /v1/legal/account-deletion
```

## What Still Comes Next

1. Seed sample users and shipments into Supabase.
2. Add driver assignment endpoints.
3. Add owner truck management endpoints.
4. Add KYC document upload records without paid KYC verification.
5. Replace placeholder media storage with Supabase Storage.
6. Deploy backend to Render, Railway, Fly.io, or Supabase Edge alternative.
7. Point frontend `EXPO_PUBLIC_API_BASE_URL` to the deployed backend.
