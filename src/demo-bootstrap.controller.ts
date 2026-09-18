import { Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'crypto';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

type StaffInput = {
  password?: string;
  customerEmail?: string;
  driverEmail?: string;
  driverEmail2?: string;
  adminEmail?: string;
  dispatcherEmail?: string;
  truckOwnerEmail?: string;
};

type StaffAccount = {
  email: string;
  phone: string;
  fullName: string;
  role: UserRole;
  // Only the first driver owns and drives a truck out of the box (TRK-DRV-01).
  // The second is deliberately truck-less, so the "Fleet assignments" screen has
  // a real verified driver available to link to TRK-OWN-01 right after bootstrap.
  fixtures?: 'driver-with-truck' | 'driver-without-truck';
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
    if (!expected || !secret || !this.secretsMatch(expected, secret)) {
      throw new ForbiddenException('Demo bootstrap is not enabled.');
    }

    const password = body.password && body.password.length >= 6 ? body.password : 'password123';
    const accounts: StaffAccount[] = [
      {
        email: (body.customerEmail ?? 'customer@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550144',
        fullName: 'Trako Customer',
        role: 'CUSTOMER',
      },
      {
        email: (body.driverEmail ?? 'driver@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550143',
        fullName: 'Trako Driver',
        role: 'DRIVER',
        fixtures: 'driver-with-truck',
      },
      {
        email: (body.driverEmail2 ?? 'driver2@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550148',
        fullName: 'Trako Driver Two',
        role: 'DRIVER',
        fixtures: 'driver-without-truck',
      },
      {
        email: (body.adminEmail ?? 'admin@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550146',
        fullName: 'Trako Admin',
        role: 'ADMIN',
      },
      {
        email: (body.dispatcherEmail ?? 'dispatcher@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550145',
        fullName: 'Trako Dispatcher',
        role: 'DISPATCHER',
      },
      {
        email: (body.truckOwnerEmail ?? 'truckowner@tracko.ng').trim().toLowerCase(),
        phone: '+2348035550147',
        fullName: 'Trako Truck Owner',
        role: 'TRUCK_OWNER',
      },
    ];

    const users = [];
    const errors = [];
    for (const account of accounts) {
      try {
        const user = await this.upsertStaff(account, password);
        if (account.fixtures === 'driver-with-truck') await this.ensureDriverFixtures(user.id);
        if (account.fixtures === 'driver-without-truck') await this.ensureDriverBankAccount(user.id);
        if (account.role === 'TRUCK_OWNER') await this.ensureTruckOwnerFixtures(user.id);
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
        customer: 'https://www.trako.com.ng/customer',
        driver: 'https://www.trako.com.ng/driver',
        admin: 'https://www.trako.com.ng/admin',
        dispatcher: 'https://www.trako.com.ng/dispatcher',
        truckOwner: 'https://www.trako.com.ng/owner',
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
    await this.ensureDriverBankAccount(driverId);
    await this.setupVehicle(driverId);
  }

  private async ensureDriverBankAccount(driverId: string) {
    await this.prisma.bankAccount.upsert({
      where: { userId: driverId },
      update: {
        bankName: 'Preview Bank',
        maskedNumber: '**** 0012',
        holderName: 'Trako Driver',
        verified: true,
        payoutSchedule: 'Weekly',
        pendingPayout: 'N0',
      },
      create: {
        userId: driverId,
        bankName: 'Preview Bank',
        maskedNumber: '**** 0012',
        holderName: 'Trako Driver',
        verified: true,
        payoutSchedule: 'Weekly',
        pendingPayout: 'N0',
      },
    });
  }

  private secretsMatch(expected: string, presented: string) {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const presentedBuffer = Buffer.from(presented, 'utf8');
    return expectedBuffer.length === presentedBuffer.length && timingSafeEqual(expectedBuffer, presentedBuffer);
  }

  private async setupVehicle(driverId: string) {
    const vehicle = await this.prisma.vehicle.upsert({
      where: { plateNumber: 'TRK-DRV-01' },
      update: {
        ownerId: driverId,
        assignedDriverId: driverId,
        type: 'Box truck',
        capacityKg: 30000,
        capacityM3: 45,
        registrationState: 'Lagos',
        isActive: true,
      },
      create: {
        ownerId: driverId,
        assignedDriverId: driverId,
        plateNumber: 'TRK-DRV-01',
        type: 'Box truck',
        capacityKg: 30000,
        capacityM3: 45,
        registrationState: 'Lagos',
        isActive: true,
      },
    });

    await this.verifyVehicleDocuments(vehicle.id);
  }

  // Seeds a second, owner-registered truck with no driver assigned - lets the
  // "Fleet assignments" admin/dispatcher screen be exercised immediately after bootstrap
  // instead of only ever having the driver's own self-owned demo truck to look at.
  private async ensureTruckOwnerFixtures(ownerId: string) {
    const vehicle = await this.prisma.vehicle.upsert({
      where: { plateNumber: 'TRK-OWN-01' },
      update: {
        ownerId,
        type: 'Flatbed',
        capacityKg: 30000,
        capacityM3: 55,
        registrationState: 'Lagos',
        isActive: true,
      },
      create: {
        ownerId,
        plateNumber: 'TRK-OWN-01',
        type: 'Flatbed',
        capacityKg: 30000,
        capacityM3: 55,
        registrationState: 'Lagos',
        isActive: true,
      },
    });

    await this.verifyVehicleDocuments(vehicle.id);
  }

  private async verifyVehicleDocuments(vehicleId: string) {
    const expires = new Date();
    expires.setUTCFullYear(expires.getUTCFullYear() + 1);
    const documents = [
      { type: 'REGISTRATION', title: 'Vehicle registration' },
      { type: 'INSURANCE', title: 'Insurance certificate' },
      { type: 'ROADWORTHINESS', title: 'Roadworthiness certificate' },
    ];
    await Promise.all(documents.map((document) => this.prisma.$executeRawUnsafe(
      `insert into "VehicleDocument" ("id", "vehicleId", "type", "title", "state", "number", "expires", "reviewNote", "reviewedAt")
       values ($1, $2, $3, $4, 'VERIFIED'::"DriverDocumentState", $5, $6, $7, current_timestamp)
       on conflict ("vehicleId", "type") do update set
         "title" = excluded."title", "state" = excluded."state", "number" = excluded."number",
         "expires" = excluded."expires", "reviewNote" = excluded."reviewNote", "reviewedAt" = current_timestamp,
         "updatedAt" = current_timestamp`,
      `${vehicleId}-${document.type.toLowerCase()}`,
      vehicleId,
      document.type,
      document.title,
      `DEMO-${document.type}`,
      expires,
      'Verified fixture for the Trako test-mode workflow.',
    )));
  }
}
