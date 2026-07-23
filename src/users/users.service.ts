import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type CreateUserInput = {
  email: string;
  phone: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput) {
    const email = input.email.trim().toLowerCase();
    const phone = input.phone.trim();
    const existing = await this.prisma.user.findFirst({ where: { OR: [{ email }, { phone }] } });
    if (existing) throw new ConflictException('An account already exists for this email or phone.');

    return this.prisma.user.create({
      data: {
        email,
        phone,
        passwordHash: input.passwordHash,
        role: input.role,
        availableRoles: [input.role],
        profile: { create: { fullName: input.fullName.trim() } },
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
