import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthUser } from '../common/types/auth-user';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AuthUser): Promise<AuthUser> {
    if (!payload?.sub || !payload?.role) {
      throw new UnauthorizedException('A valid login session is required.');
    }

    const user = await this.users.findById(payload.sub).catch(() => null);
    if (!user || !user.isActive || user.verificationStatus === 'SUSPENDED') {
      throw new UnauthorizedException('This account is no longer active.');
    }

    const availableRoles = user.availableRoles?.length ? user.availableRoles : [user.role];
    if (!availableRoles.includes(payload.role)) {
      throw new UnauthorizedException('This account no longer has access to the requested role.');
    }

    return {
      ...payload,
      email: user.email,
      verificationStatus: user.verificationStatus,
    };
  }
}
