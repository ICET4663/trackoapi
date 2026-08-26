const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function upsertStaff({ email, phone, fullName, role }) {
  const passwordHash = await bcrypt.hash(process.env.DEMO_STAFF_PASSWORD || 'password123', 12);

  return prisma.user.upsert({
    where: { email },
    update: {
      phone,
      passwordHash,
      role,
      availableRoles: [role],
      verificationStatus: 'VERIFIED',
      isActive: true,
      profile: {
        upsert: {
          create: { fullName },
          update: { fullName },
        },
      },
    },
    create: {
      email,
      phone,
      passwordHash,
      role,
      availableRoles: [role],
      verificationStatus: 'VERIFIED',
      isActive: true,
      profile: { create: { fullName } },
    },
    include: { profile: true },
  });
}

async function main() {
  const admin = await upsertStaff({
    email: process.env.DEMO_ADMIN_EMAIL || 'admin@tracko.ng',
    phone: process.env.DEMO_ADMIN_PHONE || '+2348035550146',
    fullName: 'Tracko Admin',
    role: 'ADMIN',
  });

  const dispatcher = await upsertStaff({
    email: process.env.DEMO_DISPATCHER_EMAIL || 'dispatcher@tracko.ng',
    phone: process.env.DEMO_DISPATCHER_PHONE || '+2348035550145',
    fullName: 'Tracko Dispatcher',
    role: 'DISPATCHER',
  });

  console.log('Demo staff ready:');
  console.log(`Admin: ${admin.email}`);
  console.log(`Dispatcher: ${dispatcher.email}`);
  console.log(`Password: ${process.env.DEMO_STAFF_PASSWORD || 'password123'}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
