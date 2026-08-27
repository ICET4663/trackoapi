import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RequestUserService } from './request-user.service';
import type { AuthUser } from './types/auth-user';

// This service is the single choke point every controller in the app calls to identify
// the caller. It used to silently authenticate unauthenticated requests as a full-
// privilege preview user (including ADMIN) - the most severe finding of the whole
// security audit. These tests exist to make sure that regression can never come back
// unnoticed.
describe('RequestUserService', () => {
  const driverUser: AuthUser = { sub: 'driver-1', role: 'DRIVER', email: 'driver@tracko.ng', verificationStatus: 'VERIFIED' };
  let jwt: { verifyAsync: jest.Mock };
  let service: RequestUserService;

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn() };
    service = new RequestUserService(jwt as unknown as JwtService);
  });

  describe('fromAuthorizationHeader', () => {
    it('throws Unauthorized when no header is provided at all', async () => {
      await expect(service.fromAuthorizationHeader(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    it('throws Unauthorized for a header with no bearer scheme', async () => {
      await expect(service.fromAuthorizationHeader('sometoken')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws Unauthorized for an empty bearer token', async () => {
      await expect(service.fromAuthorizationHeader('Bearer ')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws Unauthorized when the JWT fails verification (expired/tampered/wrong secret)', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      await expect(service.fromAuthorizationHeader('Bearer bad.token.here')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws Unauthorized when the token verifies but is missing sub/role', async () => {
      jwt.verifyAsync.mockResolvedValue({ email: 'x@example.com' });
      await expect(service.fromAuthorizationHeader('Bearer valid.token')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns the real payload for a valid token, regardless of the fallbackRole hint', async () => {
      jwt.verifyAsync.mockResolvedValue(driverUser);
      // The second argument is a legacy no-op - passing a role that doesn't match the
      // token's real role must never change the outcome or the returned identity.
      const result = await service.fromAuthorizationHeader('Bearer good.token', 'ADMIN');
      expect(result).toEqual(driverUser);
    });

    it('never authenticates as anyone when the header is absent, no matter what role hint is passed', async () => {
      await expect(service.fromAuthorizationHeader(undefined, 'ADMIN')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('requireRole', () => {
    it('throws Forbidden when the authenticated caller has the wrong role', async () => {
      jwt.verifyAsync.mockResolvedValue(driverUser);
      await expect(service.requireRole('Bearer good.token', ['ADMIN', 'DISPATCHER'])).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws Unauthorized (not Forbidden) when there is no valid session at all', async () => {
      await expect(service.requireRole(undefined, ['ADMIN'])).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns the user when their real role is in the allowed list', async () => {
      jwt.verifyAsync.mockResolvedValue(driverUser);
      const result = await service.requireRole('Bearer good.token', ['DRIVER', 'ADMIN']);
      expect(result).toEqual(driverUser);
    });
  });
});
