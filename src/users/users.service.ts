import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CreateUserInput = {
  email: string;
  phone: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  // Free-form signup profile blob from the multi-step forms. Only the fields that
  // map to real Profile columns are stored; anything else is ignored.
  profile?: Record<string, unknown>;
  // Admin-created staff skip KYC, so the caller can start them VERIFIED. Left
  // undefined for self-registration, which keeps the schema default (PENDING).
  verificationStatus?: VerificationStatus;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput) {
    const email = input.email.trim().toLowerCase();
    const phone = input.phone.trim();
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
    if (existing) throw new ConflictException('An account already exists for this email or phone.');

    const profile = input.profile ?? {};
    return this.prisma.user.create({
      data: {
        email,
        phone,
        passwordHash: input.passwordHash,
        role: input.role,
        availableRoles: [input.role],
        ...(input.verificationStatus ? { verificationStatus: input.verificationStatus } : {}),
        profile: {
          create: {
            fullName: input.fullName.trim(),
            address: optionalString(profile.address),
            city: optionalString(profile.city),
            state: optionalString(profile.state),
          },
        },
      },
      include: { profile: true },
    });
  }

  async findByEmailOrPhone(identifier: string) {
    const value = identifier.trim().toLowerCase();
    return this.prisma.user.findFirst({
      where: { OR: [{ email: value }, { phone: identifier.trim() }] },
      include: { profile: true },
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { profile: true } });
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }
}
