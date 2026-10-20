// Checks the ShipmentInternalNote table after prisma/manual-sql/20261019_add_shipment_internal_notes.sql:
// RLS on, no policies, Supabase's anon/authenticated roles cannot read or write it, and the
// API's own role can insert and read a note. Everything runs in one transaction that is
// rolled back, so no note is left behind.
// Usage (API repo, production DATABASE_URL in .env): node scripts/check-shipment-notes-db.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROLLBACK = new Error('rollback');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

async function denied(tx, role, sql) {
  await tx.$executeRawUnsafe('savepoint probe');
  try {
    if (role) await tx.$executeRawUnsafe(`set local role ${role}`);
    await tx.$queryRawUnsafe(sql);
    return false;
  } catch {
    return true;
  } finally {
    await tx.$executeRawUnsafe('rollback to savepoint probe');
  }
}

async function main() {
  const [table] = await prisma.$queryRawUnsafe(
    `select c.relrowsecurity as rls, (select count(*)::int from pg_policies where tablename = 'ShipmentInternalNote') as policies
     from pg_class c where c.relname = 'ShipmentInternalNote' and c.relkind = 'r'`,
  );
  check('table exists', Boolean(table));
  if (!table) return;
  check('row level security enabled', table.rls === true);
  check('no policies', table.policies === 0, `${table.policies} found`);

  await prisma.$transaction(async (tx) => {
    const roles = (await tx.$queryRawUnsafe(`select rolname from pg_roles where rolname in ('anon', 'authenticated')`)).map((r) => r.rolname);
    for (const role of roles) {
      check(`${role} cannot read`, await denied(tx, role, 'select * from "ShipmentInternalNote" limit 1'));
      check(`${role} cannot insert`, await denied(tx, role, `insert into "ShipmentInternalNote" ("id","shipmentId","authorId","authorRole","body") values ('probe','x','x','ADMIN','x')`));
    }

    const [staff] = await tx.$queryRawUnsafe(`select "id", "role"::text as role from "User" where "role" in ('ADMIN', 'DISPATCHER') limit 1`);
    const [shipment] = await tx.$queryRawUnsafe(`select "id" from "Shipment" limit 1`);
    if (staff && shipment) {
      const inserted = await tx.$queryRawUnsafe(
        `insert into "ShipmentInternalNote" ("id","shipmentId","authorId","authorRole","body") values (gen_random_uuid()::text, $1, $2, $3, 'db check') returning "id"`,
        shipment.id, staff.id, staff.role,
      );
      const read = await tx.$queryRawUnsafe(`select count(*)::int as n from "ShipmentInternalNote" where "id" = $1`, inserted[0].id);
      check('API role can insert and read', read[0].n === 1);
      check('blank note refused', await denied(tx, null, `insert into "ShipmentInternalNote" ("id","shipmentId","authorId","authorRole","body") values ('probe2','${shipment.id}','${staff.id}','ADMIN','   ')`));
    }
    throw ROLLBACK;
  }, { timeout: 60000, maxWait: 15000 }).catch((error) => { if (error !== ROLLBACK) throw error; });
}

main()
  .then(() => {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    process.exitCode = results.length && results.every((r) => r.ok) ? 0 : 1;
  })
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
