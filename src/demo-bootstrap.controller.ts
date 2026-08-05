import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma/prisma.service';

type StaffInput = {
  password?: string;
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
      users.push(await this.upsertStaff(account, password));
    }

    return {
      ok: true,
      message: 'Demo staff accounts are ready.',
      password,
      users,
      links: {
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
}
