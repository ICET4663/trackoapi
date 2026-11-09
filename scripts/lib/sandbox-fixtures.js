// Shared by create-review-accounts.js and create-tester-accounts.js: verified sandbox users and
// a driver's ready-to-dispatch truck (bank account, verified documents), so a store reviewer or
// closed tester can run a whole trip without KYC or document review.
const bcrypt = require('bcryptjs');

async function upsertUser(prisma, { email, phone, fullName, role, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const fields = { phone, passwordHash, role, availableRoles: [role], verificationStatus: 'VERIFIED', isActive: true };
  return prisma.user.upsert({
    where: { email },
    update: { ...fields, profile: { upsert: { create: { fullName }, update: { fullName } } } },
    create: { email, ...fields, profile: { create: { fullName } } },
  });
}

async function ensureDriverFixtures(prisma, driverId, holderName, plateNumber, { numberPrefix = 'REVIEW', reviewNote = 'Verified fixture for store review.' } = {}) {
  const bank = { bankName: 'Preview Bank', maskedNumber: '**** 0012', holderName, verified: true, payoutSchedule: 'Weekly', pendingPayout: 'N0' };
  await prisma.bankAccount.upsert({ where: { userId: driverId }, update: bank, create: { userId: driverId, ...bank } });

  const truck = { ownerId: driverId, assignedDriverId: driverId, type: 'Box truck', capacityKg: 30000, capacityM3: 45, registrationState: 'Lagos', isActive: true };
  const vehicle = await prisma.vehicle.upsert({ where: { plateNumber }, update: truck, create: { plateNumber, ...truck } });

  // Same verified document set the demo bootstrap gives its fixture truck.
  const expires = new Date();
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  const documents = [
    { type: 'REGISTRATION', title: 'Vehicle registration' },
    { type: 'INSURANCE', title: 'Insurance certificate' },
    { type: 'ROADWORTHINESS', title: 'Roadworthiness certificate' },
  ];
  for (const document of documents) {
    await prisma.$executeRawUnsafe(
      `insert into "VehicleDocument" ("id", "vehicleId", "type", "title", "state", "number", "expires", "reviewNote", "reviewedAt")
       values ($1, $2, $3, $4, 'VERIFIED'::"DriverDocumentState", $5, $6, $7, current_timestamp)
       on conflict ("vehicleId", "type") do update set
         "title" = excluded."title", "state" = excluded."state", "number" = excluded."number",
         "expires" = excluded."expires", "reviewNote" = excluded."reviewNote", "reviewedAt" = current_timestamp,
         "updatedAt" = current_timestamp`,
      `${vehicle.id}-${document.type.toLowerCase()}`,
      vehicle.id,
      document.type,
      document.title,
      `${numberPrefix}-${document.type}`,
      expires,
      reviewNote,
    );
  }
  return vehicle;
}

module.exports = { upsertUser, ensureDriverFixtures };
