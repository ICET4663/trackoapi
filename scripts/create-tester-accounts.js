// Creates (or refreshes) the Google Play closed-test accounts: for each tester one customer and one
// driver login (tester01.customer@trako.com.ng, tester01.driver@trako.com.ng, ...), verified, the
// driver with a ready truck. These are sandbox accounts (src/common/store-reviewer.ts): they always
// pay in Paystack test mode and their loads are only offered to sandbox drivers, so a tester never
// moves real money or blocks a real customer. Public sign-up refuses these addresses.
//
// Each tester gets their own random password (the same for both of their logins). Passwords are
// never printed: they go to the login sheet given with --out, which must be outside this repo.
// Running it again resets the passwords of the testers it covers, so send the new sheet.
//
// usage: node scripts/create-tester-accounts.js --out C:\path\tester-logins.csv [--count 12] [--start 1] [--force] [--dry-run]
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TESTER = 99;

function parseArgs(argv) {
  const options = { count: 12, start: 1, force: false, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[++i];
    else if (arg === '--count') options.count = Number(argv[++i]);
    else if (arg === '--start') options.start = Number(argv[++i]);
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count must be a whole number of at least 1.');
  if (!Number.isInteger(options.start) || options.start < 1) throw new Error('--start must be a whole number of at least 1.');
  if (options.start + options.count - 1 > MAX_TESTER) throw new Error(`Tester numbers go up to ${MAX_TESTER}.`);
  if (!options.dryRun) {
    if (!options.out) throw new Error('Give the login sheet path with --out (outside this repo).');
    const out = path.resolve(options.out);
    const repo = path.resolve(__dirname, '..');
    if (out.toLowerCase().startsWith(repo.toLowerCase() + path.sep)) throw new Error('The login sheet holds passwords: write it outside this repo.');
    if (fs.existsSync(out) && !options.force) throw new Error(`${out} already exists. Use --force to replace it.`);
    options.out = out;
  }
  return options;
}

// 12 characters without look-alikes (0/O, 1/l/I), easy to type on a phone.
function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function testerAccounts(number) {
  const id = String(number).padStart(2, '0');
  const phone = String(number).padStart(3, '0');
  return {
    id,
    customer: { email: `tester${id}.customer@trako.com.ng`, phone: `+2348035560${phone}`, fullName: `Tester ${id} Customer`, role: 'CUSTOMER' },
    driver: { email: `tester${id}.driver@trako.com.ng`, phone: `+2348035561${phone}`, fullName: `Tester ${id} Driver`, role: 'DRIVER' },
    plate: `TRK-TST-${id}`,
  };
}

const csvCell = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const numbers = Array.from({ length: options.count }, (_, index) => options.start + index);

  if (options.dryRun) {
    for (const number of numbers) {
      const tester = testerAccounts(number);
      console.log(`Tester ${tester.id}: ${tester.customer.email} (CUSTOMER), ${tester.driver.email} (DRIVER, truck ${tester.plate})`);
    }
    console.log('Dry run: nothing written.');
    return;
  }

  const { PrismaClient } = require('@prisma/client');
  const { upsertUser, ensureDriverFixtures } = require('./lib/sandbox-fixtures');
  const prisma = new PrismaClient();
  try {
    // Rows are added only after a tester's accounts are saved, so the sheet never lists a password
    // the database does not have.
    fs.writeFileSync(options.out, 'tester,customer_login,driver_login,password,truck\n', { mode: 0o600 });
    for (const number of numbers) {
      const tester = testerAccounts(number);
      const password = generatePassword();
      await upsertUser(prisma, { ...tester.customer, password });
      const driver = await upsertUser(prisma, { ...tester.driver, password });
      await ensureDriverFixtures(prisma, driver.id, tester.driver.fullName, tester.plate, {
        numberPrefix: 'TEST',
        reviewNote: 'Verified fixture for closed testing.',
      });
      fs.appendFileSync(options.out, [`Tester ${tester.id}`, tester.customer.email, tester.driver.email, password, tester.plate].map(csvCell).join(',') + '\n');
      console.log(`Tester ${tester.id}: ${tester.customer.email} (CUSTOMER), ${tester.driver.email} (DRIVER, truck ${tester.plate})`);
    }
    console.log(`Login sheet written to ${options.out} (passwords are in the sheet, not shown here).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, testerAccounts, generatePassword };
