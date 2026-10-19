-- Private, append-only shipment notes for operations staff (ADMIN, DISPATCHER).
-- Safe to re-run. The API connects as the table owner, which bypasses RLS; Supabase's
-- public roles get no rights and no policies, so the table is unreachable through the
-- Supabase Data API even if the anon key is known.
begin;

create table if not exists "ShipmentInternalNote" (
  "id" text not null,
  "shipmentId" text not null,
  "authorId" text not null,
  "authorRole" text not null,
  "body" text not null,
  "createdAt" timestamp(3) not null default current_timestamp,
  constraint "ShipmentInternalNote_pkey" primary key ("id"),
  constraint "ShipmentInternalNote_staff_role" check ("authorRole" in ('ADMIN', 'DISPATCHER')),
  constraint "ShipmentInternalNote_body_length" check (char_length(btrim("body")) between 1 and 4000),
  constraint "ShipmentInternalNote_shipmentId_fkey" foreign key ("shipmentId") references "Shipment"("id") on delete restrict on update cascade,
  constraint "ShipmentInternalNote_authorId_fkey" foreign key ("authorId") references "User"("id") on delete restrict on update cascade
);

create index if not exists "ShipmentInternalNote_shipmentId_createdAt_id_idx"
  on "ShipmentInternalNote"("shipmentId", "createdAt", "id");

alter table "ShipmentInternalNote" enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table "ShipmentInternalNote" from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table "ShipmentInternalNote" from authenticated;
  end if;
end $$;

commit;
