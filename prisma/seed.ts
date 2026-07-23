import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function upsertUser(input: {
  email: string;
  phone: string;
  fullName: string;
  role: UserRole;
  availableRoles?: UserRole[];
}) {
  const passwordHash = await bcrypt.hash('password123', 12);
  return prisma.user.upsert({
    where: { email: input.email },
    update: {
      phone: input.phone,
      passwordHash,
      role: input.role,
      availableRoles: input.availableRoles ?? [input.role],
      verificationStatus: 'VERIFIED',
      isActive: true,
      profile: {
        upsert: {
          create: { fullName: input.fullName },
          update: { fullName: input.fullName },
        },
      },
    },
    create: {
      email: input.email,
      phone: input.phone,
      passwordHash,
      role: input.role,
      availableRoles: input.availableRoles ?? [input.role],
      verificationStatus: 'VERIFIED',
      profile: { create: { fullName: input.fullName } },
    },
    include: { profile: true },
  });
}

async function main() {
  const customer = await upsertUser({
    email: 'customer@tracko.ng',
    phone: '+2348035550142',
    fullName: 'Tracko Customer',
    role: 'CUSTOMER',
  });

  const driver = await upsertUser({
    email: 'driver@tracko.ng',
    phone: '+2348035550143',
    fullName: 'Musa Ibrahim',
    role: 'DRIVER',
  });

  const owner = await upsertUser({
    email: 'truckowner@tracko.ng',
    phone: '+2348035550144',
    fullName: 'Amina Bello',
    role: 'TRUCK_OWNER',
  });

  await upsertUser({
    email: 'dispatcher@tracko.ng',
    phone: '+2348035550145',
    fullName: 'Tracko Dispatcher',
    role: 'DISPATCHER',
  });

  await upsertUser({
    email: 'admin@tracko.ng',
    phone: '+2348035550146',
    fullName: 'Tracko Admin',
    role: 'ADMIN',
  });

  const vehicle = await prisma.vehicle.upsert({
    where: { plateNumber: 'TRK-245-LA' },
    update: {
      ownerId: owner.id,
      assignedDriverId: driver.id,
      type: 'Box truck',
      capacityKg: 12000,
      registrationState: 'Lagos',
    },
    create: {
      ownerId: owner.id,
      assignedDriverId: driver.id,
      plateNumber: 'TRK-245-LA',
      type: 'Box truck',
      capacityKg: 12000,
      registrationState: 'Lagos',
    },
  });

  const shipment = await prisma.shipment.upsert({
    where: { reference: 'TRK-SEED-001' },
    update: {
      status: 'IN_TRANSIT',
      quotedPriceKobo: 28000000,
    },
    create: {
      reference: 'TRK-SEED-001',
      customerId: customer.id,
      status: 'IN_TRANSIT',
      pickupLabel: 'Apapa Port',
      pickupAddress: 'Apapa, Lagos',
      destinationLabel: 'Wuse Market',
      destinationAddress: 'Wuse, Abuja',
      cargoDescription: 'Electronics',
      cargoWeightKg: 1200,
      quotedPriceKobo: 28000000,
      distanceKm: 742,
      durationMinutes: 840,
      pickupContactPhone: '+2348035550142',
      timeline: {
        create: [
          { status: 'DRAFT', note: 'Shipment created from seed data.' },
          { status: 'IN_TRANSIT', note: 'Driver started trip.' },
        ],
      },
    },
  });

  await prisma.driverAssignment.upsert({
    where: { id: 'seed-assignment-001' },
    update: {
      shipmentId: shipment.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      status: 'ACCEPTED',
    },
    create: {
      id: 'seed-assignment-001',
      shipmentId: shipment.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    },
  });

  await prisma.$executeRaw`
    insert into "SavedAddress" ("id", "userId", "label", "line", "city", "address", "icon", "isDefaultPickup")
    values
      ('seed-address-home', ${customer.id}, 'Home', 'Lekki Phase 1', 'Lagos', 'Lekki Phase 1, Lagos', 'home', true),
      ('seed-address-office', ${customer.id}, 'Office', 'Victoria Island', 'Lagos', 'Victoria Island, Lagos', 'business', false)
    on conflict ("id") do update set
      "label" = excluded."label",
      "line" = excluded."line",
      "city" = excluded."city",
      "address" = excluded."address",
      "icon" = excluded."icon",
      "isDefaultPickup" = excluded."isDefaultPickup",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "PaymentMethod" ("id", "userId", "brand", "maskedNumber", "detail", "type", "isDefault", "expiry", "holderName")
    values ('seed-payment-card', ${customer.id}, 'Visa', '**** 4242', 'Seed preview card', 'CARD'::"PaymentMethodType", true, '12/29', 'Tracko Customer')
    on conflict ("id") do update set
      "brand" = excluded."brand",
      "maskedNumber" = excluded."maskedNumber",
      "detail" = excluded."detail",
      "type" = excluded."type",
      "isDefault" = excluded."isDefault",
      "expiry" = excluded."expiry",
      "holderName" = excluded."holderName",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "BillingCharge" ("id", "userId", "paymentMethodId", "ref", "dateLabel", "amount")
    values ('seed-billing-001', ${customer.id}, 'seed-payment-card', 'TRK-SEED-001', 'Jul 22, 2026', 'N280,000')
    on conflict ("id") do nothing
  `;

  await prisma.$executeRaw`
    insert into "BankAccount" ("id", "userId", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "pendingPayout")
    values ('seed-bank-driver', ${driver.id}, 'Preview Bank', '**** 0012', 'Musa Ibrahim', true, 'Weekly', 'N0')
    on conflict ("userId") do update set
      "bankName" = excluded."bankName",
      "maskedNumber" = excluded."maskedNumber",
      "holderName" = excluded."holderName",
      "verified" = excluded."verified",
      "payoutSchedule" = excluded."payoutSchedule",
      "pendingPayout" = excluded."pendingPayout",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "DriverDocument" ("id", "userId", "title", "meta", "state", "expires", "number")
    values
      ('seed-doc-license', ${driver.id}, 'Driver license', 'Valid until Dec 2027', 'VERIFIED'::"DriverDocumentState", '2027-12-31'::timestamp, 'FRSC-TRACKO-001'),
      ('seed-doc-insurance', ${driver.id}, 'Vehicle insurance', 'Upload required', 'MISSING'::"DriverDocumentState", null, null)
    on conflict ("id") do update set
      "title" = excluded."title",
      "meta" = excluded."meta",
      "state" = excluded."state",
      "expires" = excluded."expires",
      "number" = excluded."number",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "SafetySettings" ("id", "userId", "shareLiveTripLocation", "nightDrivingCheckIns", "emergencyContact")
    values ('seed-safety-driver', ${driver.id}, true, true, '+2348035550143')
    on conflict ("userId") do update set
      "shareLiveTripLocation" = excluded."shareLiveTripLocation",
      "nightDrivingCheckIns" = excluded."nightDrivingCheckIns",
      "emergencyContact" = excluded."emergencyContact",
      "updatedAt" = current_timestamp
  `;

  for (const key of ['shipmentStatusUpdates', 'liveTrackingAlerts', 'driverOffers', 'escrowPayments', 'push', 'email']) {
    await prisma.$executeRaw`
      insert into "NotificationPreference" ("userId", "role", "key", "value")
      values (${customer.id}, 'CUSTOMER'::"UserRole", ${key}, true)
      on conflict ("userId", "role", "key") do update set "value" = excluded."value", "updatedAt" = current_timestamp
    `;
  }

  await prisma.$executeRaw`
    insert into "KycSubmission" ("id", "userId", "role", "status", "idType", "idNumber", "note")
    values ('seed-kyc-customer', ${customer.id}, 'CUSTOMER'::"UserRole", 'PENDING'::"KycSubmissionStatus", 'NIN', '00000000000', 'Seed KYC pending review.')
    on conflict ("id") do update set
      "status" = excluded."status",
      "idType" = excluded."idType",
      "idNumber" = excluded."idNumber",
      "note" = excluded."note",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "KycSubmissionDocument" ("id", "submissionId", "type", "label", "url")
    values
      ('seed-kyc-doc-id', 'seed-kyc-customer', 'ID_FRONT', 'Government ID', 'preview://id-front'),
      ('seed-kyc-doc-selfie', 'seed-kyc-customer', 'SELFIE', 'Selfie', 'preview://selfie')
    on conflict ("id") do nothing
  `;

  await prisma.$executeRaw`
    insert into "Escrow" ("id", "shipmentId", "amount", "currency", "status", "arrivalConfirmed")
    values ('seed-escrow-001', ${shipment.id}, 28000000, 'NGN', 'HELD'::"EscrowStatus", true)
    on conflict ("shipmentId") do update set
      "amount" = excluded."amount",
      "currency" = excluded."currency",
      "status" = excluded."status",
      "arrivalConfirmed" = excluded."arrivalConfirmed",
      "updatedAt" = current_timestamp
  `;

  await prisma.$executeRaw`
    insert into "MediaAsset" ("id", "userId", "shipmentId", "kind", "url", "label", "mimeType")
    values ('seed-media-cargo', ${customer.id}, ${shipment.id}, 'CARGO_PHOTO'::"MediaKind", 'preview://cargo-photo', 'Cargo photo', 'image/jpeg')
    on conflict ("id") do nothing
  `;

  const conversation = await prisma.conversation.upsert({
    where: { id: 'seed-conversation-001' },
    update: { subject: 'Shipment TRK-SEED-001' },
    create: { id: 'seed-conversation-001', subject: 'Shipment TRK-SEED-001' },
  });

  await prisma.message.upsert({
    where: { id: 'seed-message-001' },
    update: { body: 'Hello, the shipment is now in transit.' },
    create: {
      id: 'seed-message-001',
      conversationId: conversation.id,
      senderId: driver.id,
      kind: 'TEXT',
      body: 'Hello, the shipment is now in transit.',
    },
  });

  console.log('Seed complete. Login password for sample users: password123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
