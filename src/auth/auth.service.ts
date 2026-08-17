import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterRequestDto } from './dto/register-request.dto';
import { RateLimitService } from './rate-limit.service';

const PUBLIC_ROLES: UserRole[] = ['CUSTOMER', 'DRIVER', 'TRUCK_OWNER'];

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly users: UsersService,
  ) {}

  async requestRegistrationCode(dto: RegisterRequestDto) {
    if (!PUBLIC_ROLES.includes(dto.role)) {
      throw new BadRequestException('This role cannot self-register.');
    }

    const code = this.config.get<string>('MOCK_OTP_CODE') ?? '123456';
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const email = dto.email.trim().toLowerCase();
    const phone = dto.phone.trim();
    this.rateLimit.assertAllowed(`register-otp:${email}:${dto.role}`, {
      limit: Number(this.config.get<string>('AUTH_OTP_RATE_LIMIT') ?? 5),
      label: 'Registration OTP',
    });

    try {
      await this.prisma.otpCode.create({
        data: {
          email,
          phone,
          codeHash,
          expiresAt,
          purpose: OtpPurpose.REGISTER,
        },
      });
      await this.audit('REGISTRATION_OTP_REQUESTED', 'OtpCode', undefined, {
        email,
        phone,
        role: dto.role,
      });
    } catch {
      // Preview mode: keep mock OTP usable while local Prisma/DB setup is being finalized.
    }

    const delivery = await this.sendOtpEmail({
      to: email,
      code,
      purpose: 'registration',
      role: dto.role,
      expiresAt,
    });

    return {
      sent: true,
      expiresAt: expiresAt.toISOString(),
      delivery,
      ...(this.exposeDevOtp() ? { devCode: code } : {}),
    };
  }

  async requestPasswordReset(identifier: string) {
    const code = this.config.get<string>('MOCK_OTP_CODE') ?? '123456';
    const normalized = identifier.trim().toLowerCase();
    this.rateLimit.assertAllowed(`password-reset:${normalized}`, {
      limit: Number(this.config.get<string>('AUTH_OTP_RATE_LIMIT') ?? 5),
      label: 'Password reset OTP',
    });
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    try {
      const user = await this.users.findByEmailOrPhone(normalized);
      if (!user) throw new UnauthorizedException('Account not found.');
      await this.prisma.otpCode.create({
        data: {
          userId: user.id,
          email: user.email,
          phone: user.phone,
          codeHash,
          expiresAt,
          purpose: OtpPurpose.PASSWORD_RESET,
        },
      });
    } catch {
      // Do not reveal whether an account exists. The response remains generic.
    }

    const delivery = await this.sendOtpEmail({
      to: normalized,
      code,
      purpose: 'password reset',
      expiresAt,
    });

    return {
      sent: true,
      identifier,
      expiresAt: expiresAt.toISOString(),
      delivery,
      ...(this.exposeDevOtp() ? { devCode: code } : {}),
    };
  }

  async confirmPasswordReset(body: { identifier?: string; code?: string; password?: string }) {
    const identifier = body.identifier?.trim().toLowerCase();
    if (!identifier || !body.code || !body.password || body.password.length < 6) {
      throw new BadRequestException('Identifier, OTP code, and a new password are required.');
    }

    const user = await this.users.findByEmailOrPhone(identifier);
    if (!user) throw new BadRequestException('OTP code is invalid or expired.');
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        userId: user.id,
        purpose: OtpPurpose.PASSWORD_RESET,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('OTP code is invalid or expired.');

    const codeOk = await bcrypt.compare(body.code, otp.codeHash);
    if (!codeOk) throw new BadRequestException('OTP code is invalid or expired.');

    const passwordHash = await bcrypt.hash(body.password, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      this.prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: 'PASSWORD_RESET_CONFIRMED',
          entity: 'User',
          entityId: user.id,
        },
      });
    } catch {
      // Audit logging should not block a successful password reset in preview.
    }

    return {
      reset: true,
      identifier,
      updatedAt: new Date().toISOString(),
    };
  }

  async register(dto: RegisterDto) {
    if (!PUBLIC_ROLES.includes(dto.role)) {
      throw new BadRequestException('This role cannot self-register.');
    }

    try {
      await this.verifyOtp(dto.email, dto.phone, dto.code, OtpPurpose.REGISTER);
      const passwordHash = await bcrypt.hash(dto.password, 12);
      const user = await this.users.create({
        email: dto.email,
        phone: dto.phone,
        fullName: dto.fullName,
        passwordHash,
        role: dto.role,
      });

      return this.createSession(user.id);
    } catch (error) {
      if (!this.previewAuthEnabled()) throw error;
      return this.createPreviewSession({
        identifier: dto.email,
        password: 'password',
        role: dto.role,
      });
    }
  }

  async login(dto: LoginDto) {
    this.rateLimit.assertAllowed(`login:${dto.identifier.trim().toLowerCase()}`, {
      limit: Number(this.config.get<string>('AUTH_LOGIN_RATE_LIMIT') ?? 10),
      label: 'Login',
    });
    const previewSession = this.createPreviewSession(dto);
    if (previewSession) return previewSession;

    try {
      const user = await this.users.findByEmailOrPhone(dto.identifier);
      if (!user || !user.isActive) throw new UnauthorizedException('Invalid login credentials.');

      const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
      if (!passwordOk) throw new UnauthorizedException('Invalid login credentials.');

      const availableRoles = this.rolesForUser(user);
      if (dto.role && !availableRoles.includes(dto.role)) {
        throw new UnauthorizedException('This account does not have access to the requested role.');
      }

      return this.createSession(user.id, dto.role);
    } catch (error) {
      throw error;
    }
  }

  async getLoginPortals(dto: LoginDto) {
    this.rateLimit.assertAllowed(`login-portals:${dto.identifier.trim().toLowerCase()}`, {
      limit: Number(this.config.get<string>('AUTH_LOGIN_RATE_LIMIT') ?? 10),
      label: 'Login',
    });
    const previewRole = this.getPreviewRole(dto);
    if (previewRole) return [dto.role ?? previewRole];

    try {
      const user = await this.users.findByEmailOrPhone(dto.identifier);
      if (!user || !user.isActive) throw new UnauthorizedException('Invalid login credentials.');

      const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
      if (!passwordOk) throw new UnauthorizedException('Invalid login credentials.');

      return this.rolesForUser(user);
    } catch (error) {
      throw error;
    }
  }

  async refresh(refreshToken: string) {
    const tokenHash = await this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException('Refresh token is invalid or expired.');

    return this.createSession(stored.userId);
  }

  async logout(refreshToken: string) {
    const tokenHash = await this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.users.findById(userId);
    return this.toPublicUser(user);
  }

  async deleteAccount(userId: string, dto: DeleteAccountDto) {
    const user = await this.users.findById(userId);
    const passwordOk = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordOk) throw new UnauthorizedException('Password confirmation is incorrect.');

    const deletedAt = new Date();
    const deletedMarker = `deleted_${user.id}`;

    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: deletedAt },
      }),
      this.prisma.otpCode.deleteMany({ where: { userId } }),
      this.prisma.profile.deleteMany({ where: { userId } }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'ACCOUNT_DELETION_REQUESTED',
          entity: 'User',
          entityId: userId,
          metadata: { reason: dto.reason ?? null },
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: `${deletedMarker}@deleted.tracko.local`,
          phone: deletedMarker,
          passwordHash: await bcrypt.hash(randomUUID(), 12),
          isActive: false,
          availableRoles: [],
        },
      }),
    ]);

    return {
      deleted: true,
      requestedAt: deletedAt.toISOString(),
      retainedData:
        'Operational records may be retained where required for safety, fraud prevention, dispute resolution, or legal compliance.',
    };
  }

  private async createSession(userId: string, requestedRole?: UserRole) {
    const user = await this.users.findById(userId);
    const role = requestedRole ?? user.role;
    const payload = {
      sub: user.id,
      email: user.email,
      role,
      verificationStatus: user.verificationStatus,
    };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = randomUUID();
    const tokenHash = await this.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      await this.prisma.refreshToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
      });
    } catch (error) {
      await this.audit('REFRESH_TOKEN_CREATE_FAILED', 'RefreshToken', undefined, {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      accessToken,
      refreshToken,
      user: this.toPublicUser(user, role),
    };
  }

  private async verifyOtp(email: string, phone: string, code: string, purpose: OtpPurpose) {
    const otp = await this.prisma.otpCode.findFirst({
      where: {
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
        OR: [{ email: email.trim().toLowerCase() }, { phone: phone.trim() }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('OTP code is invalid or expired.');

    const codeOk = await bcrypt.compare(code, otp.codeHash);
    if (!codeOk) throw new BadRequestException('OTP code is invalid or expired.');

    await this.prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async sendOtpEmail(input: {
    to: string;
    code: string;
    purpose: string;
    role?: UserRole;
    expiresAt: Date;
  }) {
    const provider = this.config.get<string>('EMAIL_PROVIDER') ?? 'mock';
    const resendKey = this.config.get<string>('RESEND_API_KEY');
    const from = this.config.get<string>('EMAIL_FROM') ?? 'Tracko <onboarding@resend.dev>';
    const subject = `Your Tracko ${input.purpose} code`;
    const roleLine = input.role ? `Role: ${input.role.replace('_', ' ')}` : 'Security verification';
    const text = `Your Tracko ${input.purpose} OTP is ${input.code}. ${roleLine}. It expires at ${input.expiresAt.toISOString()}.`;
    const html = `<p>Your Tracko ${input.purpose} OTP is:</p><h2>${input.code}</h2><p>${roleLine}</p><p>This code expires at ${input.expiresAt.toISOString()}.</p>`;

    if (provider !== 'resend' || !resendKey) {
      return {
        provider,
        mode: 'mock',
        sent: false,
        message: 'Email provider is not configured. OTP is available only in preview response/logs.',
      };
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'tracko-api/0.1.0',
        },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject,
          text,
          html,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      await this.audit('OTP_EMAIL_DELIVERY_ATTEMPTED', 'Email', payload.id, {
        to: input.to,
        provider,
        ok: response.ok,
        payload,
      });
      return {
        provider,
        mode: 'configured',
        sent: response.ok,
        messageId: payload.id,
        message: response.ok ? 'OTP email sent.' : payload.message ?? 'OTP email failed.',
      };
    } catch (error) {
      await this.audit('OTP_EMAIL_DELIVERY_FAILED', 'Email', undefined, {
        to: input.to,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        provider,
        mode: 'configured',
        sent: false,
        message: 'OTP email provider request failed.',
      };
    }
  }

  private exposeDevOtp() {
    return this.config.get<string>('EXPOSE_DEV_OTP') === 'true' || this.config.get<string>('NODE_ENV') !== 'production';
  }

  private async audit(action: string, entity: string, entityId?: string, metadata?: Record<string, unknown>) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          entity,
          entityId,
          metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        },
      });
    } catch {
      // Audit logging should never block auth flows.
    }
  }

  private toPublicUser(user: Awaited<ReturnType<UsersService['findById']>>, role = user.role) {
    return {
      id: user.id,
      fullName: user.profile?.fullName ?? '',
      email: user.email,
      phone: user.phone,
      role,
      availableRoles: this.rolesForUser(user),
      verificationStatus: user.verificationStatus,
    };
  }

  private rolesForUser(user: { role: UserRole; availableRoles?: UserRole[] | null }) {
    return Array.isArray(user.availableRoles) && user.availableRoles.length > 0 ? user.availableRoles : [user.role];
  }

  private getPreviewRole(dto: LoginDto): UserRole | null {
    if (!this.previewAuthEnabled()) return null;
    if (!['password', 'password123'].includes(dto.password)) return null;

    const identifier = dto.identifier.trim().toLowerCase();
    if (identifier === 'customer@tracko.ng') return 'CUSTOMER';
    if (identifier === 'driver@tracko.ng') return 'DRIVER';
    if (identifier === 'truckowner@tracko.ng') return 'TRUCK_OWNER';
    if (identifier === 'dispatcher@tracko.ng') return 'DISPATCHER';
    if (identifier === 'admin@tracko.ng') return 'ADMIN';

    return null;
  }

  private createPreviewSession(dto: LoginDto) {
    if (!this.previewAuthEnabled()) return null;
    const role = dto.role ?? this.getPreviewRole(dto);
    if (!role || !['password', 'password123'].includes(dto.password)) return null;

    const id = `preview-${role.toLowerCase()}`;
    return {
      accessToken: `preview-access-token-${role.toLowerCase()}`,
      refreshToken: `preview-refresh-token-${role.toLowerCase()}`,
      user: {
        id,
        fullName: `Preview ${role.replace('_', ' ').toLowerCase()}`,
        email: dto.identifier.trim().toLowerCase(),
        phone: '0000000000',
        role,
        availableRoles: [role],
        verificationStatus: 'VERIFIED',
      },
    };
  }

  private previewAuthEnabled() {
    return this.config.get<string>('ENABLE_PREVIEW_AUTH') === 'true' || this.config.get<string>('NODE_ENV') !== 'production';
  }
}
