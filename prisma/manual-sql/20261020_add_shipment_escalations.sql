-- Shipment escalations: operations staff flag a shipment for admin attention with a
-- reason; an admin closes it with a resolution note. Informational only: an escalation
-- never holds or releases payment (only a dispute does). Safe to re-run.
-- Same access model as ShipmentInternalNote: the API connects as the table owner, which
-- bypasses RLS; Supabase's public roles get no rights and no policies.
begin;

create table if not exists "ShipmentEscalation" (
  "id" text not null,
  "shipmentId" text not null,
  "raisedById" text not null,
  "raisedByRole" text not null,
  "reason" text not null,
  "status" text not null default 'OPEN',
  "resolutionNote" text,
  "resolvedById" text,
  "resolvedAt" timestamp(3),
  "createdAt" timestamp(3) not null default current_timestamp,
  constraint "ShipmentEscalation_pkey" primary key ("id"),
  constraint "ShipmentEscalation_staff_role" check ("raisedByRole" in ('ADMIN', 'DISPATCHER')),
  constraint "ShipmentEscalation_reason_length" check (char_length(btrim("reason")) between 10 and 2000),
  constraint "ShipmentEscalation_status" check ("status" in ('OPEN', 'RESOLVED')),
  constraint "ShipmentEscalation_shipmentId_fkey" foreign key ("shipmentId") references "Shipment"("id") on delete restrict on update cascade,
  constraint "ShipmentEscalation_raisedById_fkey" foreign key ("raisedById") references "User"("id") on delete restrict on update cascade,
  constraint "ShipmentEscalation_resolvedById_fkey" foreign key ("resolvedById") references "User"("id") on delete restrict on update cascade
);

-- Defined outside create table so a re-run replaces an older version of the rule. The
-- "resolutionNote is not null" matters: char_length(null) is null, and a CHECK that
-- evaluates to null passes, so without it a RESOLVED row with no note was accepted.
alter table "ShipmentEscalation" drop constraint if exists "ShipmentEscalation_resolution";
alter table "ShipmentEscalation" add constraint "ShipmentEscalation_resolution" check (
  ("status" = 'OPEN' and "resolutionNote" is null and "resolvedById" is null and "resolvedAt" is null)
  or ("status" = 'RESOLVED' and "resolvedById" is not null and "resolvedAt" is not null
      and "resolutionNote" is not null and char_length(btrim("resolutionNote")) between 10 and 2000)
);

-- At most one open escalation per shipment; a second one adds to the first instead.
create unique index if not exists "ShipmentEscalation_one_open_per_shipment"
  on "ShipmentEscalation"("shipmentId") where "status" = 'OPEN';
create index if not exists "ShipmentEscalation_status_createdAt_idx"
  on "ShipmentEscalation"("status", "createdAt");
create index if not exists "ShipmentEscalation_shipmentId_createdAt_idx"
  on "ShipmentEscalation"("shipmentId", "createdAt");

alter table "ShipmentEscalation" enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table "ShipmentEscalation" from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table "ShipmentEscalation" from authenticated;
  end if;
end $$;

commit;
