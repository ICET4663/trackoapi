-- Tracko backend stage two schema.
-- Run this in Supabase SQL Editor after the base Prisma schema exists.
-- It adds production tables for settings, KYC, media, and escrow workflows.

do $$
begin
  create type "PaymentMethodType" as enum ('CARD', 'BANK_TRANSFER');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "DriverDocumentState" as enum ('VERIFIED', 'EXPIRING', 'MISSING');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "KycSubmissionStatus" as enum ('PENDING', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "MediaKind" as enum ('CARGO_PHOTO', 'POD_PHOTO', 'DOCUMENT', 'VOICE_NOTE');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type "EscrowStatus" as enum ('PENDING', 'FUNDED', 'HELD', 'RELEASE_READY', 'RELEASED', 'DISPUTED', 'REFUNDED');
exception
  when duplicate_object then null;
end $$;

create table if not exists "SavedAddress" (
  "id" text primary key default concat('addr_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "label" text not null,
  "line" text not null,
  "city" text not null,
  "address" text,
  "icon" text,
  "isDefaultPickup" boolean not null default false,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create index if not exists "SavedAddress_userId_idx" on "SavedAddress"("userId");

create table if not exists "PaymentMethod" (
  "id" text primary key default concat('pm_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "brand" text not null,
  "maskedNumber" text not null,
  "detail" text,
  "type" "PaymentMethodType" not null,
  "isDefault" boolean not null default false,
  "expiry" text,
  "holderName" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create index if not exists "PaymentMethod_userId_idx" on "PaymentMethod"("userId");

create table if not exists "BillingCharge" (
  "id" text primary key default concat('bill_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "paymentMethodId" text references "PaymentMethod"("id") on delete set null,
  "ref" text not null,
  "dateLabel" text not null,
  "amount" text not null,
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "BillingCharge_userId_idx" on "BillingCharge"("userId");
create index if not exists "BillingCharge_paymentMethodId_idx" on "BillingCharge"("paymentMethodId");

create table if not exists "BankAccount" (
  "id" text primary key default concat('bank_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null unique references "User"("id") on delete cascade,
  "bankName" text not null,
  "maskedNumber" text not null,
  "holderName" text not null,
  "verified" boolean not null default false,
  "payoutSchedule" text not null,
  "pendingPayout" text not null default 'N0',
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "DriverDocument" (
  "id" text primary key default concat('doc_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "title" text not null,
  "meta" text not null,
  "state" "DriverDocumentState" not null default 'MISSING',
  "issued" timestamp(3),
  "expires" timestamp(3),
  "number" text,
  "fileUrl" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create index if not exists "DriverDocument_userId_idx" on "DriverDocument"("userId");

create table if not exists "SafetySettings" (
  "id" text primary key default concat('safety_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null unique references "User"("id") on delete cascade,
  "shareLiveTripLocation" boolean not null default true,
  "nightDrivingCheckIns" boolean not null default true,
  "emergencyContact" text,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create table if not exists "NotificationPreference" (
  "id" text primary key default concat('pref_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "role" "UserRole" not null,
  "key" text not null,
  "value" boolean not null default true,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp,
  constraint "NotificationPreference_userId_role_key_key" unique ("userId", "role", "key")
);

create index if not exists "NotificationPreference_userId_idx" on "NotificationPreference"("userId");

create table if not exists "KycSubmission" (
  "id" text primary key default concat('kyc_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text not null references "User"("id") on delete cascade,
  "role" "UserRole" not null,
  "status" "KycSubmissionStatus" not null default 'PENDING',
  "idType" text not null,
  "idNumber" text not null,
  "bvn" text,
  "licenceNumber" text,
  "licenceExpiry" timestamp(3),
  "note" text,
  "reviewedAt" timestamp(3),
  "reviewedBy" text,
  "submittedAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

create index if not exists "KycSubmission_userId_idx" on "KycSubmission"("userId");
create index if not exists "KycSubmission_status_idx" on "KycSubmission"("status");

create table if not exists "KycSubmissionDocument" (
  "id" text primary key default concat('kycdoc_', replace(gen_random_uuid()::text, '-', '')),
  "submissionId" text not null references "KycSubmission"("id") on delete cascade,
  "type" text not null,
  "label" text not null,
  "url" text not null,
  "mediaId" text,
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "KycSubmissionDocument_submissionId_idx" on "KycSubmissionDocument"("submissionId");

create table if not exists "MediaAsset" (
  "id" text primary key default concat('media_', replace(gen_random_uuid()::text, '-', '')),
  "userId" text references "User"("id") on delete set null,
  "shipmentId" text references "Shipment"("id") on delete set null,
  "conversationId" text,
  "kind" "MediaKind" not null,
  "url" text,
  "storageKey" text,
  "label" text not null,
  "transcript" text,
  "durationSeconds" integer,
  "mimeType" text,
  "createdAt" timestamp(3) not null default current_timestamp
);

create index if not exists "MediaAsset_userId_idx" on "MediaAsset"("userId");
create index if not exists "MediaAsset_shipmentId_idx" on "MediaAsset"("shipmentId");
create index if not exists "MediaAsset_conversationId_idx" on "MediaAsset"("conversationId");

create table if not exists "Escrow" (
  "id" text primary key default concat('escrow_', replace(gen_random_uuid()::text, '-', '')),
  "shipmentId" text not null unique references "Shipment"("id") on delete cascade,
  "amount" integer not null,
  "currency" text not null default 'NGN',
  "status" "EscrowStatus" not null default 'PENDING',
  "arrivalConfirmed" boolean not null default false,
  "proofOfDeliveryUploaded" boolean not null default false,
  "customerDeliveryConfirmed" boolean not null default false,
  "disputeWindowClear" boolean not null default false,
  "platformApproved" boolean not null default false,
  "createdAt" timestamp(3) not null default current_timestamp,
  "updatedAt" timestamp(3) not null default current_timestamp
);

alter table "SavedAddress" enable row level security;
alter table "PaymentMethod" enable row level security;
alter table "BillingCharge" enable row level security;
alter table "BankAccount" enable row level security;
alter table "DriverDocument" enable row level security;
alter table "SafetySettings" enable row level security;
alter table "NotificationPreference" enable row level security;
alter table "KycSubmission" enable row level security;
alter table "KycSubmissionDocument" enable row level security;
alter table "MediaAsset" enable row level security;
alter table "Escrow" enable row level security;
