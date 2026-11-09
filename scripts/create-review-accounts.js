// Creates (or refreshes) the store-reviewer accounts: one customer and one driver each for
// Apple App Review and Google Play review. Separate from the public demo accounts so a
// reviewer never shares a password that is printed in this repo, and so acceptance scripts
// that reset demo state can't break a review in progress.
//
// usage: REVIEW_PASSWORD_APPLE=... REVIEW_PASSWORD_GOOGLE=... node scripts/create-review-accounts.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { upsertUser: upsert, ensureDriverFixtures: ensureFixtures } = require('./lib/sandbox-fixtures');

const prisma = new PrismaClient();

const STORES = [
  { key: 'apple', label: 'Apple Review', password: process.env.REVIEW_PASSWORD_APPLE, phoneBase: 201, plate: 'TRK-REV-A1' },
  { key: 'google', label: 'Google Review', password: process.env.REVIEW_PASSWORD_GOOGLE, phoneBase: 203, plate: 'TRK-REV-G1' },
];

const upsertUser = (input) => upsert(prisma, input);
const ensureDriverFixtures = (driverId, holderName, plateNumber) => ensureFixtures(prisma, driverId, holderName, plateNumber);

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
