alter table "SafetySettings"
  add column if not exists "availableForAssignments" boolean not null default true;

comment on column "SafetySettings"."availableForAssignments" is
  'Driver-controlled availability for receiving new shipment offers. Existing trips are unaffected.';
