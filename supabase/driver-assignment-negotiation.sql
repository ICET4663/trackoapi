-- Adds driver counteroffer support to "DriverAssignment" (feature: a driver can
-- propose a different price on an OFFERED load instead of only accept/reject;
-- dispatch/admin can then accept or reject the counteroffer). Needed for
-- POST /v1/shipments/assignments/:id/counter-offer and
-- POST /v1/shipments/assignments/:id/counter-offer/respond.
--
-- Safe to run even if some/all of these already exist.

alter table public."DriverAssignment"
  add column if not exists "proposedPriceKobo" integer,
  add column if not exists "proposedNote" text,
  add column if not exists "proposedAt" timestamptz;
