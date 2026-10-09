# Temporary-database lifecycle test

This test covers the real persisted MVP path:

1. Create verified customer, driver, dispatcher, admin, truck, documents, and payout account.
2. Create a shipment and escrow record.
3. Process a correctly signed Paystack-style success webhook.
4. Approve the shipment, offer it to an eligible driver, and accept it.
5. Record pickup and arrival GPS, trip stages, and proof of delivery; reject further GPS writes after delivery and release without adding rows.
6. Complete release checks and release escrow.
7. Confirm driver earnings, request withdrawal, approve it, and mark it paid.

The runner creates a unique PostgreSQL schema and drops it even when a test fails. It refuses Supabase URLs, non-test database names, and reuse of `DATABASE_URL`.

## Local run

Start a dedicated PostgreSQL test database, then run in PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgresql://tracko:tracko_test_password@localhost:5432/tracko_test"
npm run test:lifecycle:db
```

Docker Desktop users can start the repository's PostgreSQL service first with `docker compose up -d postgres`. The existing `docker-compose.yml` database is named `tracko`; create or use a separate database whose name contains `test` for this lifecycle suite.

On Windows with a local PostgreSQL 18 installation, `psql` may not be on `PATH`. Create the dedicated database with:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -U postgres -d postgres -c "CREATE DATABASE tracko_test;"
```

`psql` prompts for the local PostgreSQL password. Set `TEST_DATABASE_URL` only in your current shell, URL-encode any special characters in its password, and never commit or share the value. The runner rejects database names without `test` or `testing` before opening a connection.

GitHub Actions provides its own PostgreSQL 16 service and runs the lifecycle test automatically on pushes and pull requests to `main`.
