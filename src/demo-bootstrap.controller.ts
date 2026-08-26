import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { Public } from './common/decorators/public.decorator';
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
  @Public()
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
    const errors = [];
    for (const account of accounts) {
      try {
        const user = await this.upsertStaff(account, password);
        if (account.role === 'DRIVER') await this.ensureDriverFixtures(user.id);
        users.push(user);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ email: account.email, role: account.role, message });
      }
    }

    return {
      ok: errors.length === 0,
      message: errors.length === 0 ? 'Demo accounts are ready.' : 'Demo bootstrap finished with errors.',
      password,
      users,
      errors,
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
    await this.prisma.bankAccount.upsert({
      where: { userId: driverId },
      update: {
        bankName: 'Preview Bank',
        maskedNumber: '**** 0012',
        holderName: 'Tracko Driver',
        verified: true,
        payoutSchedule: 'Weekly',
        pendingPayout: 'N0',
      },
      create: {
        userId: driverId,
        bankName: 'Preview Bank',
        maskedNumber: '**** 0012',
        holderName: 'Tracko Driver',
        verified: true,
        payoutSchedule: 'Weekly',
        pendingPayout: 'N0',
      },
    });

    await this.prisma.vehicle.upsert({
      where: { plateNumber: 'TRK-DRV-01' },
      update: {
        ownerId: driverId,
        assignedDriverId: driverId,
        type: 'Box truck',
        capacityKg: 30000,
        registrationState: 'Lagos',
        isActive: true,
      },
      create: {
        ownerId: driverId,
        assignedDriverId: driverId,
        plateNumber: 'TRK-DRV-01',
        type: 'Box truck',
        capacityKg: 30000,
        registrationState: 'Lagos',
        isActive: true,
      },
    });
  }
}


