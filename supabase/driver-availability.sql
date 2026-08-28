alter table "SafetySettings"
  add column if not exists "availableForAssignments" boolean not null default true,
  add column if not exists "lastKnownLatitude" double precision,
  add column if not exists "lastKnownLongitude" double precision,
  add column if not exists "locationUpdatedAt" timestamp;

comment on column "SafetySettings"."availableForAssignments" is
  'Driver-controlled availability for receiving new shipment offers. Existing trips are unaffected.';

comment on column "SafetySettings"."locationUpdatedAt" is
  'Time the online driver last shared foreground location for pickup-distance matching.';
