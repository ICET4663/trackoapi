# Tracko Full Workflow Preview

Use this after the Supabase SQL files have run successfully.

Run SQL in this order:

```text
supabase/base-schema.sql
supabase/backend-stage-two.sql
supabase/backend-stage-three.sql
supabase/demo-seed.sql
supabase/check-readiness.sql
```

## 1. Apply Mobile Service Integration

Run this in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api\scripts\apply-mobile-workflow-integration.ps1"
```

This adds frontend service wrappers for:

- shipments
- driver assignment
- operations
- live tracking
- proof of delivery
- notifications

## 2. Start Backend

Run this in a backend terminal:

```powershell
cd "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api"
npm run start:dev
```

Check:

```text
http://localhost:4000/v1/health
```

## 3. Run Backend Smoke Workflow

In a second backend terminal:

```powershell
cd "C:\Users\hp\Documents\Codex\2026-07-02\f\tracko-api"
npm run smoke:workflow
```

Expected final line:

```text
DONE Tracko smoke workflow passed
```

## 4. Start Mobile App

Run this in the Expo app folder:

```powershell
cd "C:\Users\hp\Downloads\CargoLink-Logistics-main (6)\CargoLink-Logistics-main"
npx expo start --web --lan --clear
```

Open:

```text
http://localhost:8081
```

## 5. Preview Login Accounts

```text
customer@tracko.ng / password123
driver@tracko.ng / password123
truckowner@tracko.ng / password123
dispatcher@tracko.ng / password123
admin@tracko.ng / password123
```

## 6. Full Manual Preview Flow

1. Customer creates shipment.
2. Dispatcher views shipments and available drivers.
3. Dispatcher assigns driver.
4. Driver accepts or rejects assignment.
5. Driver sends location ping.
6. Driver submits proof of delivery.
7. Customer sees shipment updates.
8. Customer/dispatcher see notifications.
9. Customer opens dispute or support ticket.
10. Dispatcher resolves dispute.

## 7. What To Fix After Preview

Some screens may still show mock data even though backend endpoints exist. Fix
those by connecting the screen button or query to the generated services:

- `shipmentService`
- `operationsService`
- `trackingService`
- `notificationsService`
