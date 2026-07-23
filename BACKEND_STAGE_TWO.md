# Tracko Backend Stage Two

This stage adds the database structure needed for the app screens that are already connected to the backend preview routes.

## What was added

- Saved customer addresses
- Payment method placeholders and billing history
- Driver payout account and driver documents
- Driver safety settings
- Notification preferences
- KYC submissions and KYC documents
- Uploaded media records
- Shipment escrow records and release checks

## Supabase setup

Open Supabase SQL Editor and run:

```text
C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api\supabase\backend-stage-two.sql
```

If you still need the app's direct preview Supabase tables, also run:

```text
C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api\supabase\preview-tables.sql
```

## Local backend commands

Run these from:

```powershell
cd "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api"
```

Validate schema:

```powershell
npm run prisma:validate
```

Generate Prisma client after schema changes:

```powershell
npm run prisma:generate
```

Apply Prisma migrations when local Prisma is healthy:

```powershell
npm run prisma:migrate
```

Seed demo users and workflow records:

```powershell
npm run db:seed
```

Start backend:

```powershell
npm run start:dev
```

## Switch the app data service to the backend

The current app folder may still read some dashboard lists directly from Supabase.
Run this from PowerShell to switch those reads to the NestJS backend `/v1/data/...` routes:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api\scripts\switch-app-data-to-backend.ps1"
```

Then restart Expo:

```powershell
cd "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"
npx expo start --web --lan --clear
```

## Demo login

Use one of these accounts:

- `customer@tracko.ng`
- `driver@tracko.ng`
- `truckowner@tracko.ng`
- `dispatcher@tracko.ng`
- `admin@tracko.ng`

Password:

```text
password
```

The seed password is also:

```text
password123
```
