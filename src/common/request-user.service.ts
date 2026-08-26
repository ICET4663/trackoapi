import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import type { AuthUser } from './types/auth-user';

@Injectable()
export class RequestUserService {
  constructor(private readonly jwt: JwtService) {}

  // The second parameter is kept for call-site compatibility across the many controllers
  // that already pass a role here, but it no longer has any bypass effect - a missing or
  // invalid token always throws, regardless of role. It previously silently authenticated
  // the caller as a full-privilege preview user (including ADMIN) whenever no token was
  // sent at all, as long as preview mode was enabled - which is the codebase's default.
  async fromAuthorizationHeader(header?: string, _fallbackRole?: UserRole): Promise<AuthUser> {
    const token = this.extractToken(header);
    if (!token) throw new UnauthorizedException('A valid login session is required.');

    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token);
      if (payload?.sub && payload?.role) return payload;
    } catch {
      throw new UnauthorizedException('A valid login session is required.');
    }

    throw new UnauthorizedException('A valid login session is required.');
  }

  async requireRole(header: string | undefined, roles: UserRole[]): Promise<AuthUser> {
    const user = await this.fromAuthorizationHeader(header);
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
}
