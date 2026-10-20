// Read-only check after prisma/manual-sql/20261020_lock_down_public_roles.sql: every public
// table has RLS on and Supabase's anon/authenticated roles hold no table rights.
// Usage (API repo, production DATABASE_URL in .env): node scripts/check-public-role-lockdown.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const rlsOff = await prisma.$queryRawUnsafe(
    `select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
  );
  const grants = await prisma.$queryRawUnsafe(
    `select table_name as table, grantee, string_agg(privilege_type, ',') as rights
     from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon', 'authenticated')
     group by 1, 2 order by 1, 2`,
  );
  const [{ n: tables }] = await prisma.$queryRawUnsafe(
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  console.log(`${rlsOff.length ? 'FAIL' : 'PASS'}  RLS on for all ${tables} public tables${rlsOff.length ? `; off: ${rlsOff.map((r) => r.table).join(', ')}` : ''}`);
  console.log(`${grants.length ? 'FAIL' : 'PASS'}  anon/authenticated hold no table rights${grants.length ? `; still: ${grants.map((g) => `${g.grantee}@${g.table}`).join(', ')}` : ''}`);
  process.exitCode = rlsOff.length || grants.length ? 1 : 0;
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
