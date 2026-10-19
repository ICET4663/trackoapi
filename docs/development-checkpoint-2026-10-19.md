# Development checkpoint: 19 October 2026

The July 1 prototype report is historical, not the current implementation baseline.
Use the application's TRACKO_ACCEPTANCE.md and TRACKO_BUILD_PROGRESS.md, with test
and deployment evidence, rather than rebuilding features described as absent there.

## Current continuation

Shipment notes API foundation (local, not deployed):

- GET /v1/operations/shipments/:id/notes returns the latest 200 notes, newest first.
- POST to the same URL accepts { "body": "Internal operational context" }.
- ADMIN and DISPATCHER only; authenticated author and role are recorded.
- Notes are append-only through this API. Correct a mistake with another note.
- prisma/manual-sql/20261019_add_shipment_internal_notes.sql creates a private table
  with foreign keys and body/role checks, enables RLS with no policies and revokes all
  rights from Supabase's anon and authenticated roles. Safe to re-run.
- Database errors must remain errors, not a fabricated empty inbox or saved note.
- No trip, payment, release-check or dispute state is changed.

Before deployment: apply the SQL file to the production database, then deploy the API.
The database has no `_prisma_migrations` table (checked 19 October), so like the earlier
files in prisma/manual-sql it is applied by hand, not with `prisma migrate deploy`.
From this repo, with the production DATABASE_URL in .env:

    npx prisma db execute --file prisma/manual-sql/20261019_add_shipment_internal_notes.sql --schema prisma/schema.prisma

Until the table exists the endpoints fail with a server error, which the app shows as
"Could not load internal notes", never as an empty list.

Validation completed: 17 focused controller/service tests passed, backend
TypeScript passed, and Prisma schema validation passed. The migration itself,
full backend suite and authenticated database integration remain unverified.

## What remains

1. Add dispatcher/admin note views with explicit loading, empty and error states.
2. Implement escalation: reason of at least 10 characters, notify admins, maintain
   an open queue, and require an admin resolution note. Escalation is informational;
   only a dispute may hold payment. This is NOT implemented by the notes API.
3. Complete remaining browser acceptance checks (notification routing and a real
   multi-device tracking journey), recording actual outcomes.
4. Test email signup/reset in a real inbox and voice capture on real phones.
5. Validate installed Android/iOS location, offline reconnect, push, uploads,
   permissions, logout/delivery cleanup and battery usage.
6. Confirm alert delivery, backup restoration, domain associations, native privacy
   disclosures and store-account setup before production submission.

Recent acceptance documents record booking/voice work as implemented and tested;
do not repeat or replace it. Production/live and physical-device claims require
fresh evidence, not merely source code or passing mocked unit tests.

