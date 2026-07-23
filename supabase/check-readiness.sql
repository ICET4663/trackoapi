-- Tracko Supabase readiness check.
-- Run this after demo-seed.sql.

select
  'User' as item,
  to_regclass('public."User"') is not null as ready
union all
select
  'Shipment',
  to_regclass('public."Shipment"') is not null
union all
select
  'DriverAssignment',
  to_regclass('public."DriverAssignment"') is not null
union all
select
  'Escrow',
  to_regclass('public."Escrow"') is not null
union all
select
  'ShipmentLocationPing',
  to_regclass('public."ShipmentLocationPing"') is not null
union all
select
  'DeliveryProof',
  to_regclass('public."DeliveryProof"') is not null
union all
select
  'Notification',
  to_regclass('public."Notification"') is not null
union all
select
  'Demo users',
  exists (
    select 1
    from "User"
    where "email" in (
      'customer@tracko.ng',
      'driver@tracko.ng',
      'truckowner@tracko.ng',
      'dispatcher@tracko.ng',
      'admin@tracko.ng'
    )
    group by true
    having count(*) = 5
  )
union all
select
  'Demo vehicle',
  exists (select 1 from "Vehicle" where "plateNumber" = 'LAG-204-TK');
