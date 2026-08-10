import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma/prisma.service';

type StaffInput = {
  password?: string;
  customerEmail?: string;
  driverEmail?: string;
  adminEmail?: string;
  dispatcherEmail?: string;
};

type StaffAccount = {
  email: string;
  phone: string;
  fullName: string;
  role: UserRole;
};

@Controller('demo')
export class DemoBootstrapController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('bootstrap-staff')
  async bootstrapStaff(@Headers('x-bootstrap-secret') secret: string | undefined, @Body() body: StaffInput) {
    const expected = this.config.get<string>('DEMO_BOOTSTRAP_SECRET');
    if (!expected || secret !== expected) {
      throw new ForbiddenException('Demo bootstrap is not enabled.');
    }

    const password = body.password && body.password.length >= 6 ? body.password : 'password123';
    const accounts: StaffAccount[] = [
      {
        email: (body.customerEmail ?? 'customer@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550144',
        fullName: 'Tracko Customer',
        role: 'CUSTOMER',
      },
      {
        email: (body.driverEmail ?? 'driver@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550143',
        fullName: 'Tracko Driver',
        role: 'DRIVER',
      },
      {
        email: (body.adminEmail ?? 'admin@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550146',
        fullName: 'Tracko Admin',
        role: 'ADMIN',
      },
      {
        email: (body.dispatcherEmail ?? 'dispatcher@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550145',
        fullName: 'Tracko Dispatcher',
        role: 'DISPATCHER',
      },
    ];

    const users = [];
    for (const account of accounts) {
      const user = await this.upsertStaff(account, password);
      if (account.role === 'DRIVER') await this.ensureDriverFixtures(user.id);
      users.push(user);
    }

    return {
      ok: true,
      message: 'Demo accounts are ready.',
      password,
      users,
      links: {
        customer: 'https://cargo-link-logistics-mm1c.vercel.app/customer',
        driver: 'https://cargo-link-logistics-mm1c.vercel.app/driver',
        admin: 'https://cargo-link-logistics-mm1c.vercel.app/admin',
        dispatcher: 'https://cargo-link-logistics-mm1c.vercel.app/dispatcher',
      },
    };
  }

  private async upsertStaff(account: StaffAccount, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.upsert({
      where: { email: account.email },
      update: {
        phone: account.phone,
        passwordHash,
        role: account.role,
        availableRoles: [account.role],
        verificationStatus: 'VERIFIED',
        isActive: true,
        profile: {
          upsert: {
            create: { fullName: account.fullName },
            update: { fullName: account.fullName },
          },
        },
      },
      create: {
        email: account.email,
        phone: account.phone,
        passwordHash,
        role: account.role,
        availableRoles: [account.role],
        verificationStatus: 'VERIFIED',
        isActive: true,
        profile: { create: { fullName: account.fullName } },
      },
      include: { profile: true },
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      fullName: user.profile?.fullName ?? account.fullName,
    };
  }

  private async ensureDriverFixtures(driverId: string) {
    await this.prisma.$executeRaw`
      insert into "BankAccount" ("id", "userId", "bankName", "maskedNumber", "holderName", "verified", "payoutSchedule", "pendingPayout")
      values ('demo-bank-driver', ${driverId}, 'Preview Bank', '**** 0012', 'Tracko Driver', true, 'Weekly', 'N0')
      on conflict ("id") do update set
        "userId" = excluded."userId",
        "bankName" = excluded."bankName",
        "maskedNumber" = excluded."maskedNumber",
        "holderName" = excluded."holderName",
        "verified" = excluded."verified",
        "payoutSchedule" = excluded."payoutSchedule",
        "pendingPayout" = excluded."pendingPayout",
        "updatedAt" = current_timestamp
    `;

    await this.prisma.$executeRaw`
      insert into "Vehicle" ("id", "ownerId", "assignedDriverId", "plateNumber", "type", "capacityKg", "registrationState", "isActive")
      values ('demo-vehicle-driver', ${driverId}, ${driverId}, 'TRK-DRV-01', 'Box truck', 30000, 'Lagos', true)
      on conflict ("id") do update set
        "ownerId" = excluded."ownerId",
        "assignedDriverId" = excluded."assignedDriverId",
        "plateNumber" = excluded."plateNumber",
        "type" = excluded."type",
        "capacityKg" = excluded."capacityKg",
        "registrationState" = excluded."registrationState",
        "isActive" = excluded."isActive",
        "updatedAt" = current_timestamp
    `;
  }
}
