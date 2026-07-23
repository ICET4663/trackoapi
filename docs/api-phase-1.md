# Phase 1 API Contract

Base URL:

```text
http://localhost:4000/v1
```

## Health

```http
GET /health
```

## Auth

### Request Registration Code

```http
POST /auth/register/request
Content-Type: application/json

{
  "email": "customer@tracko.ng",
  "phone": "+2348035550142"
}
```

Development response includes `devCode`, default `123456`.

### Register

```http
POST /auth/register
Content-Type: application/json

{
  "email": "customer@tracko.ng",
  "phone": "+2348035550142",
  "fullName": "Tracko Customer",
  "password": "password123",
  "code": "123456",
  "role": "CUSTOMER"
}
```

Allowed public roles:

- `CUSTOMER`
- `DRIVER`
- `TRUCK_OWNER`

Dispatcher and Admin accounts must later be created by admin-only endpoints.

### Login

```http
POST /auth/login
Content-Type: application/json

{
  "identifier": "customer@tracko.ng",
  "password": "password123"
}
```

### Current User

```http
GET /auth/me
Authorization: Bearer <accessToken>
```

### Refresh

```http
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "<refreshToken>"
}
```

### Logout

```http
POST /auth/logout
Content-Type: application/json

{
  "refreshToken": "<refreshToken>"
}
```

### Delete Account

```http
DELETE /auth/account
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "password": "password123",
  "reason": "Optional user reason"
}
```

This revokes active refresh tokens, removes profile and OTP records, marks the
account inactive, and anonymizes the email and phone fields. Operational records
may be retained where needed for safety, disputes, fraud prevention, accounting,
or legal compliance.

## Legal Pages

These are public HTML endpoints that can be linked from the mobile app, App Store
Connect, Google Play Console, Vercel, or Netlify.

```http
GET /legal/privacy
GET /legal/terms
GET /legal/account-deletion
```

## Portal Integration

These endpoints are used by the mobile frontend once
`EXPO_PUBLIC_API_BASE_URL=http://localhost:4000` is configured.

```http
GET /customer/portal
Authorization: Bearer <accessToken>
```

```http
GET /driver/portal
Authorization: Bearer <accessToken>
```

```http
GET /owner/portal
Authorization: Bearer <accessToken>
```

## Generic Data Integration

```http
GET /data/:collection
GET /data/:collection/:id
POST /data/:collection
Authorization: Bearer <accessToken>
```

Supported collections:

- `customer-shipments`
- `wallet-transactions`
- `shipment-offers`
- `chat-threads`
- `verification`
- `owner-trucks`
- `seeking-drivers`
- `driver-jobs`
- `active-trips`

## Shipments

```http
POST /shipments
Authorization: Bearer <customerAccessToken>
Content-Type: application/json

{
  "pickupLabel": "Apapa Port",
  "pickupAddress": "Apapa, Lagos",
  "destinationLabel": "Wuse Market",
  "destinationAddress": "Wuse, Abuja",
  "cargoDescription": "Electronics",
  "cargoWeightKg": 1200,
  "quotedPriceKobo": 28000000
}
```

```http
GET /shipments
GET /shipments/:id
Authorization: Bearer <accessToken>
```

Dispatcher/admin status update:

```http
PATCH /shipments/:id/status
Authorization: Bearer <dispatcherOrAdminAccessToken>
Content-Type: application/json

{
  "status": "IN_TRANSIT",
  "note": "Driver started trip."
}
```

## Communication

```http
GET /conversations?role=CUSTOMER
GET /conversations/:conversationId/messages
Authorization: Bearer <accessToken>
```

```http
POST /conversations/:conversationId/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "kind": "TEXT",
  "body": "Hello, please confirm pickup time."
}
```

```http
POST /conversations/:conversationId/typing
POST /voice/transcriptions
POST /notifications/push-token
POST /media/upload
Authorization: Bearer <accessToken>
```

## Next API Phase

After auth works:

1. `POST /shipments`
2. `GET /shipments`
3. `GET /shipments/:id`
4. `PATCH /shipments/:id/status`
5. `GET /dispatcher/shipments`
6. `POST /dispatch/assign-driver`
