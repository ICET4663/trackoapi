do $$
begin
  create type "DisputeStatus" as enum ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "SupportTicketStatus" as enum ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "ProofStatus" as enum ('SUBMITTED', 'APPROVED', 'REJECTED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "NotificationTone" as enum ('INFO', 'SUCCESS', 'WARNING', 'DANGER');
exception
  when duplicate_object then null;
end $$;

create table if not exists "PushToken" (
  "id" text primary key default ('push_' || gen_random_uuid()),
  "userId" text not null references "User"("id") on delete cascade,
  "token" text not null,
  "platform" text,
  "deviceId" text,
  "createdAt" timestamp not null default current_timestamp,
  "updatedAt" timestamp not null default current_timestamp,
  unique ("userId", "token")
);

create index if not exists "PushToken_userId_idx" on "PushToken" ("userId");

create table if not exists "ShipmentLocationPing" (
  "id" text primary key default ('loc_' || gen_random_uuid()),
  "shipmentId" text not null references "Shipment"("id") on delete cascade,
  "driverId" text references "User"("id") on delete set null,
  "latitude" double precision not null,
  "longitude" double precision not null,
  "heading" double precision,
  "speedKph" double precision,
  "note" text,
  "createdAt" timestamp not null default current_timestamp
);

create index if not exists "ShipmentLocationPing_shipmentId_idx" on "ShipmentLocationPing" ("shipmentId");
create index if not exists "ShipmentLocationPing_driverId_idx" on "ShipmentLocationPing" ("driverId");

create table if not exists "DeliveryProof" (
  "id" text primary key default ('pod_' || gen_random_uuid()),
  "shipmentId" text not null references "Shipment"("id") on delete cascade,
  "driverId" text references "User"("id") on delete set null,
  "photoUrl" text,
  "signatureUrl" text,
  "recipientName" text,
  "note" text,
  "status" "ProofStatus" not null default 'SUBMITTED',
  "submittedAt" timestamp not null default current_timestamp,
  "reviewedAt" timestamp,
  "reviewedBy" text
);

create index if not exists "DeliveryProof_shipmentId_idx" on "DeliveryProof" ("shipmentId");
create index if not exists "DeliveryProof_driverId_idx" on "DeliveryProof" ("driverId");

create table if not exists "Dispute" (
  "id" text primary key default ('dispute_' || gen_random_uuid()),
  "shipmentId" text references "Shipment"("id") on delete set null,
  "userId" text references "User"("id") on delete set null,
  "reason" text not null,
  "description" text,
  "priority" text not null default 'MEDIUM',
  "status" "DisputeStatus" not null default 'OPEN',
  "resolution" text,
  "createdAt" timestamp not null default current_timestamp,
  "updatedAt" timestamp not null default current_timestamp,
  "resolvedAt" timestamp
);

create index if not exists "Dispute_shipmentId_idx" on "Dispute" ("shipmentId");
create index if not exists "Dispute_userId_idx" on "Dispute" ("userId");
create index if not exists "Dispute_status_idx" on "Dispute" ("status");

create table if not exists "SupportTicket" (
  "id" text primary key default ('support_' || gen_random_uuid()),
  "shipmentId" text references "Shipment"("id") on delete set null,
  "userId" text references "User"("id") on delete set null,
  "topic" text not null,
  "channel" text not null,
  "message" text,
  "status" "SupportTicketStatus" not null default 'OPEN',
  "createdAt" timestamp not null default current_timestamp,
  "updatedAt" timestamp not null default current_timestamp,
  "resolvedAt" timestamp
);

create index if not exists "SupportTicket_shipmentId_idx" on "SupportTicket" ("shipmentId");
create index if not exists "SupportTicket_userId_idx" on "SupportTicket" ("userId");
create index if not exists "SupportTicket_status_idx" on "SupportTicket" ("status");

create table if not exists "Notification" (
  "id" text primary key default ('notification_' || gen_random_uuid()),
  "userId" text references "User"("id") on delete cascade,
  "role" "UserRole",
  "title" text not null,
  "body" text not null,
  "tone" "NotificationTone" not null default 'INFO',
  "entity" text,
  "entityId" text,
  "actionUrl" text,
  "readAt" timestamp,
  "createdAt" timestamp not null default current_timestamp
);

create index if not exists "Notification_userId_idx" on "Notification" ("userId");
create index if not exists "Notification_role_idx" on "Notification" ("role");
create index if not exists "Notification_readAt_idx" on "Notification" ("readAt");
