-- Tracko base schema.
-- Run this before backend-stage-two.sql and backend-stage-three.sql when Supabase
-- does not yet have the core Prisma tables.

create extension if not exists pgcrypto;

do $$
begin
  create type "UserRole" as enum ('CUSTOMER', 'DRIVER', 'TRUCK_OWNER', 'DISPATCHER', 'ADMIN');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "VerificationStatus" as enum ('PENDING', 'IN_REVIEW', 'ACTION_NEEDED', 'VERIFIED', 'REJECTED', 'SUSPENDED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "ShipmentStatus" as enum (
    'DRAFT',
    'QUOTED',
    'PENDING_PAYMENT',
    'ESCROW_FUNDED',
    'DRIVER_ASSIGNED',
    'DRIVER_EN_ROUTE',
    'ARRIVED_PICKUP',
    'PICKED_UP',
    'IN_TRANSIT',
    'ARRIVED_DESTINATION',
    'DELIVERED',
    'COMPLETED',
    'CANCELLED',
    'DISPUTED'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "AssignmentStatus" as enum ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "OtpPurpose" as enum ('REGISTER', 'PASSWORD_RESET');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "MessageKind" as enum ('TEXT', 'VOICE', 'ATTACHMENT', 'LOCATION', 'SYSTEM');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "DeliveryStatus" as enum ('SENT', 'DELIVERED', 'READ');
exception
  when duplicate_object then null;
end $$;

create table if not exists "User" (
  "id" text primary key default concat('user_', replace(gen_random_uuid()::text, '-', '')),
  "email" text not null unique,
  "phone" text not null unique,
  "passwordHash" text not null,
  "role" "UserRole" not null,
  "availableRoles" "UserRole"[] not null default array[]::"UserRole"[],
  "verificationStatus" "VerificationStatus" not null default 'PENDING',
  "isActive" boolean not null default true,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "Profile" (
  "id" text primary key default concat('profile_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null unique references "User"("id") on delete cascade,
  "fullName" text not null,
  "address" text,
  "city" text,
  "state" text,
  "avatarUrl" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "RefreshToken" (
  "id" text primary key default concat('refresh_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "tokenHash" text not null,
  "expiresAt" timestamp(3) not null,
  "revokedAt" timestamp(3),
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "RefreshToken_userId_idx" on "RefreshToken"("userId");

create table if not exists "OtpCode" (
  "id" text primary key default concat('otp_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text references "User"("id") on delete cascade,
  "email" text,
  "phone" text,
  "codeHash" text not null,
  "purpose" "OtpPurpose" not null,
  "expiresAt" timestamp(3) not null,
  "usedAt" timestamp(3),
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "OtpCode_email_idx" on "OtpCode"("email");
create index if not exists "OtpCode_phone_idx" on "OtpCode"("phone");

create table if not exists "Vehicle" (
  "id" text primary key default concat('vehicle_', replace(gen_random_uuid()::text, '-', '')),
  "ownerId" text not null references "User"("id") on delete restrict,
  "assignedDriverId" text references "User"("id") on delete set null,
  "plateNumber" text not null unique,
  "type" text not null,
  "capacityKg" integer,
  "registrationState" text,
  "isActive" boolean not null default true,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "Shipment" (
  "id" text primary key default concat('shipment_', replace(gen_random_uuid()::text, '-', '')),
  "reference" text not null unique,
  "customerId" text not null references "User"("id") on delete restrict,
  "status" "ShipmentStatus" not null default 'DRAFT',
  "pickupLabel" text not null,
  "pickupAddress" text not null,
  "pickupLatitude" double precision,
  "pickupLongitude" double precision,
  "destinationLabel" text not null,
  "destinationAddress" text not null,
  "destinationLatitude" double precision,
  "destinationLongitude" double precision,
  "cargoDescription" text not null,
  "cargoWeightKg" double precision,
  "cargoValueKobo" integer,
  "quotedPriceKobo" integer,
  "distanceKm" double precision,
  "durationMinutes" integer,
  "pickupContactPhone" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "DriverAssignment" (
  "id" text primary key default concat('assignment_', replace(gen_random_uuid()::text, '-', '')),
  "shipmentId" text not null references "Shipment"("id") on delete cascade,
  "driverId" text not null references "User"("id") on delete restrict,
  "vehicleId" text references "Vehicle"("id") on delete set null,
  "status" "AssignmentStatus" not null default 'OFFERED',
  "offeredAt" timestamp(3) not null default current_timestamp,
  "acceptedAt" timestamp(3),
  "rejectedAt" timestamp(3)
);

create index if not exists "DriverAssignment_shipmentId_idx" on "DriverAssignment"("shipmentId");
create index if not exists "DriverAssignment_driverId_idx" on "DriverAssignment"("driverId");

create table if not exists "ShipmentTimeline" (
  "id" text primary key default concat('timeline_', replace(gen_random_uuid()::text, '-', '')),
  "shipmentId" text not null references "Shipment"("id") on delete cascade,
  "status" "ShipmentStatus" not null,
  "note" text,
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "ShipmentTimeline_shipmentId_idx" on "ShipmentTimeline"("shipmentId");

create table if not exists "KycDocument" (
  "id" text primary key default concat('kycdoc_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null,
  "type" text not null,
  "fileUrl" text not null,
  "status" "VerificationStatus" not null default 'IN_REVIEW',
  "reviewerNotes" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "Conversation" (
  "id" text primary key default concat('conversation_', replace(gen_random_uuid()::text, '-', '')),
  "subject" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "Message" (
  "id" text primary key default concat('msg_', replace(gen_random_uuid()::text, '-', '')),
  "conversationId" text not null references "Conversation"("id") on delete cascade,
  "senderId" text not null references "User"("id") on delete restrict,
  "kind" "MessageKind" not null default 'TEXT',
  "body" text,
  "attachmentUrl" text,
  "transcript" text,
  "durationSeconds" integer,
  "deliveryStatus" "DeliveryStatus" not null default 'SENT',
  "readAt" timestamp(3),
  "createdAt" timestamp(3) not null default current_timestamp
);

create table if not exists "AuditLog" (
  "id" text primary key default concat('audit_', replace(gen_random_uuid()::text, '-', '')),
  "actorId" text references "User"("id") on delete set null,
  "action" text not null,
  "entity" text not null,
  "entityId" text,
  "metadata" jsonb,
  "createdAt" timestamp(3) not null default current_timestamp
);
