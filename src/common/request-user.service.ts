import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './types/auth-user';

const PREVIEW_USERS: Record<string, { id: string; email: string; role: UserRole }> = {
  'preview-access-token-customer': { id: 'preview-customer', email: 'customer@tracko.ng', role: 'CUSTOMER' },
  'preview-access-token-driver': { id: 'preview-driver', email: 'driver@tracko.ng', role: 'DRIVER' },
  'preview-access-token-truck_owner': { id: 'preview-truck_owner', email: 'truckowner@tracko.ng', role: 'TRUCK_OWNER' },
  'preview-access-token-dispatcher': { id: 'preview-dispatcher', email: 'dispatcher@tracko.ng', role: 'DISPATCHER' },
  'preview-access-token-admin': { id: 'preview-admin', email: 'admin@tracko.ng', role: 'ADMIN' },
};

@Injectable()
export class RequestUserService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async fromAuthorizationHeader(header?: string, fallbackRole: UserRole = 'CUSTOMER'): Promise<AuthUser> {
    const token = this.extractToken(header);
    if (!token) return this.previewOrThrow(fallbackRole);

    const preview = PREVIEW_USERS[token];
    if (preview && this.previewAuthEnabled()) return this.previewUser(preview.role, preview.email, preview.id);

    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token);
      if (payload?.sub && payload?.role) return payload;
    } catch {
      return this.previewOrThrow(fallbackRole);
    }

    return this.previewOrThrow(fallbackRole);
  }

  async requireRole(header: string | undefined, roles: UserRole[]): Promise<AuthUser> {
    const user = await this.fromAuthorizationHeader(header, roles[0] ?? 'CUSTOMER');
    if (!roles.includes(user.role)) {
      throw new ForbiddenException('This account does not have access to this action.');
    }
    return user;
  }

  private extractToken(header?: string) {
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    return token.trim();
  }

  private async previewUser(role: UserRole, email = this.emailForRole(role), fallbackId = `preview-${role.toLowerCase()}`): Promise<AuthUser> {
    try {
      const user = await this.prisma.user.findFirst({ where: { email } });
      if (user) {
        return {
          sub: user.id,
          email: user.email,
          role,
          verificationStatus: user.verificationStatus,
        };
      }
    } catch {
      // Keep local preview usable when Prisma or Supabase is not ready.
    }

    return {
      sub: fallbackId,
      email,
      role,
      verificationStatus: 'VERIFIED' as VerificationStatus,
    };
  }

  private emailForRole(role: UserRole) {
    if (role === 'DRIVER') return 'driver@tracko.ng';
    if (role === 'TRUCK_OWNER') return 'truckowner@tracko.ng';
    if (role === 'DISPATCHER') return 'dispatcher@tracko.ng';
    if (role === 'ADMIN') return 'admin@tracko.ng';
    return 'customer@tracko.ng';
  }

  private previewOrThrow(role: UserRole) {
    if (this.previewAuthEnabled()) return this.previewUser(role);
    throw new UnauthorizedException('A valid login session is required.');
  }

  private previewAuthEnabled() {
    return this.config.get<string>('ENABLE_PREVIEW_AUTH') === 'true' || this.config.get<string>('NODE_ENV') !== 'production';
  }
}
