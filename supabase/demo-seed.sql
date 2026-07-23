-- Tracko demo seed data.
-- Run this after base-schema.sql, backend-stage-two.sql, and backend-stage-three.sql.
-- The passwordHash below is intentionally a placeholder because the API uses
-- preview login for these demo accounts. For live users, register through the API.

insert into "User" ("id", "email", "phone", "passwordHash", "role", "availableRoles", "verificationStatus", "isActive")
values
  (
    'user_customer_demo',
    'customer@tracko.ng',
    '+2348000000000',
    '$2a$12$previewhashforlocaldemoonly000000000000000000000000000',
    'CUSTOMER',
    array['CUSTOMER']::"UserRole"[],
    'VERIFIED',
    true
  ),
  (
    'user_driver_demo',
    'driver@tracko.ng',
    '+2348000000001',
    '$2a$12$previewhashforlocaldemoonly000000000000000000000000000',
    'DRIVER',
    array['DRIVER']::"UserRole"[],
    'VERIFIED',
    true
  ),
  (
    'user_owner_demo',
    'truckowner@tracko.ng',
    '+2348000000002',
    '$2a$12$previewhashforlocaldemoonly000000000000000000000000000',
    'TRUCK_OWNER',
    array['TRUCK_OWNER']::"UserRole"[],
    'VERIFIED',
    true
  ),
  (
    'user_dispatcher_demo',
    'dispatcher@tracko.ng',
    '+2348000000003',
    '$2a$12$previewhashforlocaldemoonly000000000000000000000000000',
    'DISPATCHER',
    array['DISPATCHER']::"UserRole"[],
    'VERIFIED',
    true
  ),
  (
    'user_admin_demo',
    'admin@tracko.ng',
    '+2348000000004',
    '$2a$12$previewhashforlocaldemoonly000000000000000000000000000',
    'ADMIN',
    array['ADMIN']::"UserRole"[],
    'VERIFIED',
    true
  )
on conflict ("email") do update set
  "phone" = excluded."phone",
  "passwordHash" = excluded."passwordHash",
  "role" = excluded."role",
  "availableRoles" = excluded."availableRoles",
  "verificationStatus" = excluded."verificationStatus",
  "isActive" = excluded."isActive",
  "updatedAt" = current_timestamp;

insert into "Profile" ("id", "userId", "fullName", "city", "state")
values
  ('profile_customer_demo', 'user_customer_demo', 'Tracko Customer', 'Lagos', 'Lagos'),
  ('profile_driver_demo', 'user_driver_demo', 'Musa Ibrahim', 'Lagos', 'Lagos'),
  ('profile_owner_demo', 'user_owner_demo', 'Tracko Fleet Owner', 'Lagos', 'Lagos'),
  ('profile_dispatcher_demo', 'user_dispatcher_demo', 'Tracko Dispatcher', 'Lagos', 'Lagos'),
  ('profile_admin_demo', 'user_admin_demo', 'Tracko Admin', 'Lagos', 'Lagos')
on conflict ("userId") do update set
  "fullName" = excluded."fullName",
  "city" = excluded."city",
  "state" = excluded."state",
  "updatedAt" = current_timestamp;

insert into "Vehicle" ("id", "ownerId", "assignedDriverId", "plateNumber", "type", "capacityKg", "registrationState", "isActive")
values (
  'vehicle_flatbed_demo',
  'user_owner_demo',
  'user_driver_demo',
  'LAG-204-TK',
  'Flatbed truck',
  12000,
  'Lagos',
  true
)
on conflict ("plateNumber") do update set
  "ownerId" = excluded."ownerId",
  "assignedDriverId" = excluded."assignedDriverId",
  "type" = excluded."type",
  "capacityKg" = excluded."capacityKg",
  "registrationState" = excluded."registrationState",
  "isActive" = excluded."isActive",
  "updatedAt" = current_timestamp;

insert into "SavedAddress" ("id", "userId", "label", "line", "city", "address", "icon", "isDefaultPickup")
values
  (
    'addr_customer_lagos_demo',
    'user_customer_demo',
    'Lagos warehouse',
    'Apapa Industrial Estate',
    'Lagos',
    'Apapa Industrial Estate, Lagos',
    'warehouse',
    true
  ),
  (
    'addr_customer_abuja_demo',
    'user_customer_demo',
    'Abuja receiver',
    'Central Business District',
    'Abuja',
    'Central Business District, Abuja',
    'business',
    false
  )
on conflict ("id") do update set
  "label" = excluded."label",
  "line" = excluded."line",
  "city" = excluded."city",
  "address" = excluded."address",
  "icon" = excluded."icon",
  "isDefaultPickup" = excluded."isDefaultPickup",
  "updatedAt" = current_timestamp;

insert into "BankAccount" ("id", "userId", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "pendingPayout")
values (
  'bank_driver_demo',
  'user_driver_demo',
  'Preview Bank',
  '**** 1204',
  'Musa Ibrahim',
  true,
  'Weekly',
  'N0'
)
on conflict ("userId") do update set
  "bankName" = excluded."bankName",
  "maskedNumber" = excluded."maskedNumber",
  "holderName" = excluded."holderName",
  "verified" = excluded."verified",
  "payoutSchedule" = excluded."payoutSchedule",
  "pendingPayout" = excluded."pendingPayout",
  "updatedAt" = current_timestamp;

insert into "DriverDocument" ("id", "userId", "title", "meta", "state", "number")
values
  ('driver_doc_license_demo', 'user_driver_demo', 'FRSC Driver Licence', 'Verified licence', 'VERIFIED', 'FRSC-DEMO-001'),
  ('driver_doc_medical_demo', 'user_driver_demo', 'Medical Fitness', 'Due in 60 days', 'EXPIRING', 'MED-DEMO-001')
on conflict ("id") do update set
  "title" = excluded."title",
  "meta" = excluded."meta",
  "state" = excluded."state",
  "number" = excluded."number",
  "updatedAt" = current_timestamp;

insert into "SafetySettings" ("id", "userId", "shareLiveTripLocation", "nightDrivingCheckIns", "emergencyContact")
values (
  'safety_driver_demo',
  'user_driver_demo',
  true,
  true,
  '+2348000000099'
)
on conflict ("userId") do update set
  "shareLiveTripLocation" = excluded."shareLiveTripLocation",
  "nightDrivingCheckIns" = excluded."nightDrivingCheckIns",
  "emergencyContact" = excluded."emergencyContact",
  "updatedAt" = current_timestamp;
