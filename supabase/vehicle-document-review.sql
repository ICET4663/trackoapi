create table if not exists public."VehicleDocument" (
  "id" text primary key,
  "vehicleId" text not null references public."Vehicle"("id") on delete cascade,
  "type" text not null,
  "title" text not null,
  "state" public."DriverDocumentState" not null default 'MISSING',
  "number" text,
  "expires" timestamptz,
  "fileUrl" text,
  "reviewNote" text,
  "reviewedAt" timestamptz,
  "reviewedById" text references public."User"("id"),
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp,
  unique ("vehicleId", "type")
);

create index if not exists "VehicleDocument_vehicleId_idx"
  on public."VehicleDocument" ("vehicleId");

create index if not exists "VehicleDocument_state_idx"
  on public."VehicleDocument" ("state");
