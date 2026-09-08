alter table "Shipment"
  add column if not exists "quantity" text,
  add column if not exists "truckType" text,
  add column if not exists "cargoVolumeM3" double precision;

update "Shipment"
set
  "quantity" = coalesce("quantity", case when "cargoWeightKg" is not null then "cargoWeightKg"::text || ' kg' else '1 truckload' end),
  "truckType" = coalesce("truckType", 'Truck')
where "quantity" is null or "truckType" is null;
