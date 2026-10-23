// Creates (or refreshes) the store-reviewer accounts: one customer and one driver each for
// Apple App Review and Google Play review. Separate from the public demo accounts so a
// reviewer never shares a password that is printed in this repo, and so acceptance scripts
// that reset demo state can't break a review in progress.
//
// usage: REVIEW_PASSWORD_APPLE=... REVIEW_PASSWORD_GOOGLE=... node scripts/create-review-accounts.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const STORES = [
  { key: 'apple', label: 'Apple Review', password: process.env.REVIEW_PASSWORD_APPLE, phoneBase: 201, plate: 'TRK-REV-A1' },
  { key: 'google', label: 'Google Review', password: process.env.REVIEW_PASSWORD_GOOGLE, phoneBase: 203, plate: 'TRK-REV-G1' },
];

async function upsertUser({ email, phone, fullName, role, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const fields = { phone, passwordHash, role, availableRoles: [role], verificationStatus: 'VERIFIED', isActive: true };
  return prisma.user.upsert({
    where: { email },
    update: { ...fields, profile: { upsert: { create: { fullName }, update: { fullName } } } },
    create: { email, ...fields, profile: { create: { fullName } } },
  });
}

async function ensureDriverFixtures(driverId, holderName, plateNumber) {
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
      `REVIEW-${document.type}`,
      expires,
      'Verified fixture for store review.',
    );
  }
}

async function main() {
  for (const store of STORES) {
    if (!store.password || store.password.length < 10) throw new Error(`Set REVIEW_PASSWORD_${store.key.toUpperCase()} (at least 10 characters).`);
    const customer = await upsertUser({
      email: `${store.key}.review.customer@trako.com.ng`,
      phone: `+2348035550${store.phoneBase}`,
      fullName: `${store.label} Customer`,
      role: 'CUSTOMER',
      password: store.password,
    });
    const driver = await upsertUser({
      email: `${store.key}.review.driver@trako.com.ng`,
      phone: `+2348035550${store.phoneBase + 1}`,
      fullName: `${store.label} Driver`,
      role: 'DRIVER',
      password: store.password,
    });
    await ensureDriverFixtures(driver.id, `${store.label} Driver`, store.plate);
    console.log(`${store.label}: ${customer.email} (CUSTOMER), ${driver.email} (DRIVER, truck ${store.plate})`);
  }
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
