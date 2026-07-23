# Tracko Production Readiness

This backend is now ready for local and stakeholder preview with mock providers.
The remaining live-production work depends on external accounts, secret keys, and
business/legal decisions.

## Completed For Preview

- JWT authentication with refresh tokens
- Mock OTP registration flow
- Email OTP provider switch for role-aware registration
- Password reset updates the stored password and revokes old refresh tokens
- Account deletion endpoint
- Privacy, terms, and account deletion pages
- Supabase/Postgres Prisma schema
- Customer shipment creation
- Shipment timeline updates
- Dispatcher driver assignment offers
- Driver assignment accept/reject workflow
- Media metadata records for shipment assets
- Escrow placeholder records
- KYC submission and admin review queue
- Provider status endpoint
- Provider-ready KYC and payment bridge endpoints
- Operations dashboard
- Operations trip progress actions
- Dispute create and resolve placeholders
- Support ticket placeholder
- Live tracking location ping endpoints
- Delivery proof submission endpoints
- In-app notification records
- Push token persistence

## Preview URLs

```text
GET http://localhost:4000/v1/health
GET http://localhost:4000/v1/integrations/status
GET http://localhost:4000/v1/legal/privacy
GET http://localhost:4000/v1/legal/terms
GET http://localhost:4000/v1/legal/account-deletion
```

## Payment Provider Needed

Use one provider first. Paystack is the most practical first choice for a
Nigeria-focused logistics app.

Required before live money movement:

- Business Paystack account
- `PAYMENT_PROVIDER=paystack`
- `PAYSTACK_SECRET_KEY`
- Paystack webhook URL configured to:

```text
POST /v1/payments/webhooks/paystack/:event
```

Live work still required:

- Create real payment initialization call
- Paystack initialization is wired when `PAYMENT_PROVIDER=paystack` and `PAYSTACK_SECRET_KEY` are set
- Verify Paystack webhook signatures
- Mark escrow as funded after verified Paystack success webhook
- Release funds only after delivery checks pass
- Dispute and refund escrow endpoints

## KYC Provider Needed

Use one provider first. Good candidates are Smile ID, Dojah, or Mono depending on
the documents and countries you need to support.

Required before real identity checks:

- KYC provider account
- `KYC_PROVIDER=smile_id`, `dojah`, or `mono`
- Provider API keys in `.env`
- Provider webhook URL configured to:

```text
POST /v1/kyc/provider/webhooks/:provider/:event
```

Live work still required:

- Submit real identity documents
- Verify webhook signatures
- Store provider references
- Update user verification status from provider/manual review results
- Add manual review fallback for failed checks

## Maps Provider Needed

The app can keep mock/stylized maps for preview. For production dispatch,
pricing, and ETA accuracy, add:

- Google Maps Platform or Mapbox account
- Geocoding API
- Directions/Routing API
- Places/autocomplete API
- Distance matrix or route ETA API

## App Store Requirements

Before Apple App Store and Google Play submission:

- Replace placeholder company/support details in legal pages
- Publish a public privacy policy URL
- Ensure account deletion is easy to find inside the app
- Explain microphone usage for voice notes
- Explain camera/photo usage for cargo and delivery proof
- Explain location usage for live trip tracking
- Add abuse/support contact
- Add test account credentials for reviewers
- Disable mock payment and mock KYC in production builds
- Use HTTPS API URLs only
- Keep secrets out of the mobile app

## Recommended Next Build Stage

The next code stage should connect the mobile screens to the new assignment
workflow:

- Dispatcher selects an available driver
- Dispatcher sends assignment offer
- Driver sees offered shipment
- Driver accepts or rejects
- Shipment timeline updates automatically
- Customer sees updated shipment status

After that, connect the mobile operations screens to:

- `GET /v1/operations/dashboard`
- `POST /v1/operations/shipments/:id/progress`
- `POST /v1/operations/disputes`
- `PATCH /v1/operations/disputes/:id/resolve`
- `POST /v1/operations/support/tickets`

Then apply the stage three Supabase SQL:

```text
supabase/backend-stage-three.sql
```

This adds persistence for live tracking pings, proof of delivery, disputes,
support tickets, in-app notifications, and push notification tokens.
