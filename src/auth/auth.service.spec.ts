import { AuthService } from './auth.service';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma/prisma.service';
import type { RateLimitService } from './rate-limit.service';
import type { UsersService } from '../users/users.service';

// requestRegistrationCode/requestPasswordReset used to hash the same static string
// every time (MOCK_OTP_CODE, or the literal '123456' if unset) - since verifyOtp() only
// checks the submitted code against that hash with no other proof of ownership, this was
// a full password-reset account-takeover path for any account whose email is known,
// including admin@tracko.ng. These tests pin down that a real code is generated instead.
describe('AuthService.generateOtpCode (private, exercised via cast)', () => {
  function buildService(configValues: Record<string, string | undefined>) {
    const config = { get: (key: string) => configValues[key] } as unknown as ConfigService;
    return new AuthService(
      config,
      {} as JwtService,
      {} as PrismaService,
      {} as RateLimitService,
      {} as UsersService,
    ) as unknown as { generateOtpCode(): string };
  }

  it('never returns the historical hardcoded default in production-like config (no override flags set)', () => {
    const service = buildService({});
    const codes = new Set(Array.from({ length: 20 }, () => service.generateOtpCode()));

    for (const code of codes) {
      expect(code).not.toBe('123456');
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('generates a different code on (almost) every call - not a single shared static value', () => {
    const service = buildService({});
    const codes = new Set(Array.from({ length: 30 }, () => service.generateOtpCode()));

    // With 900,000 possible 6-digit codes, 30 draws landing on fewer than ~25 unique
    // values would indicate something is not actually random.
    expect(codes.size).toBeGreaterThan(25);
  });

  it('ignores MOCK_OTP_CODE unless EXPOSE_DEV_OTP is explicitly the string "true"', () => {
    const service = buildService({ MOCK_OTP_CODE: '111111' });
    const codes = Array.from({ length: 10 }, () => service.generateOtpCode());
    expect(codes.every((code) => code === '111111')).toBe(false);
  });

  it('only honours MOCK_OTP_CODE when EXPOSE_DEV_OTP is explicitly "true" (local/dev convenience)', () => {
    const service = buildService({ EXPOSE_DEV_OTP: 'true', MOCK_OTP_CODE: '111111' });
    expect(service.generateOtpCode()).toBe('111111');
  });
});

// Making the code random closes the "known static code" attack, but a genuinely random
// 6-digit code (900,000 possibilities) is still guessable within its expiry window if the
// verification step allows unlimited attempts. These tests confirm that gap is closed too,
// and that a rejected rate limit stops the flow before the real code is ever compared.
describe('AuthService OTP verification is rate-limited on the guess side, not just the request side', () => {
  function buildService(rateLimit: { assertAllowed: jest.Mock }, prismaOverrides: Record<string, unknown> = {}) {
    const config = { get: () => undefined } as unknown as ConfigService;
    const prisma = {
      otpCode: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
      ...prismaOverrides,
    } as unknown as PrismaService;
    const users = { findByEmailOrPhone: jest.fn().mockResolvedValue(null) } as unknown as UsersService;
    return { service: new AuthService(config, {} as JwtService, prisma, rateLimit as unknown as RateLimitService, users), prisma };
  }

  it('register() is blocked by the rate limiter before any OTP row is looked up', async () => {
    const assertAllowed = jest.fn().mockRejectedValue(new Error('rate limited'));
    const { service, prisma } = buildService({ assertAllowed });

    await expect(service.register({
      email: 'driver@tracko.ng', phone: '+2348030000000', fullName: 'Test', password: 'password123', code: '123456', role: 'DRIVER' as never,
    } as never)).rejects.toThrow('rate limited');

    expect(assertAllowed).toHaveBeenCalledWith(expect.stringContaining('otp-verify:REGISTER:'), expect.anything());
    expect((prisma.otpCode.findFirst as jest.Mock)).not.toHaveBeenCalled();
  });

  it('confirmPasswordReset() is blocked by the rate limiter before the account is even looked up', async () => {
    const assertAllowed = jest.fn().mockRejectedValue(new Error('rate limited'));
    const { service, prisma } = buildService({ assertAllowed });

    await expect(service.confirmPasswordReset({
      identifier: 'admin@tracko.ng', code: '123456', password: 'newpassword123',
    })).rejects.toThrow('rate limited');

    expect(assertAllowed).toHaveBeenCalledWith('otp-verify:password-reset:admin@tracko.ng', expect.anything());
    expect((prisma.otpCode.findFirst as jest.Mock)).not.toHaveBeenCalled();
  });
});

// "Pause new registrations" used to be pure copy on the platform settings screen -
// flipping it during an incident (fraud wave, abuse spike) didn't actually stop anyone
// from signing up.
describe('AuthService registration is actually gated by the pauseRegistrations platform setting', () => {
  function buildService(pauseValue: string | null, rateLimit: { assertAllowed: jest.Mock } = { assertAllowed: jest.fn().mockResolvedValue(undefined) }) {
    const config = { get: () => undefined } as unknown as ConfigService;
    const findUnique = jest.fn().mockResolvedValue(pauseValue === null ? null : { key: 'pauseRegistrations', value: pauseValue });
    const otpCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      platformSetting: { findUnique },
      otpCode: { create: otpCreate, findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const users = { findByEmailOrPhone: jest.fn().mockResolvedValue(null) } as unknown as UsersService;
    return { service: new AuthService(config, {} as JwtService, prisma, rateLimit as unknown as RateLimitService, users), findUnique, otpCreate, rateLimit };
  }

  it('requestRegistrationCode() refuses outright when paused, before hitting the rate limiter or creating an OTP', async () => {
    const { service, otpCreate, rateLimit } = buildService('true');

    await expect(service.requestRegistrationCode({
      email: 'new@tracko.ng', phone: '+2348030000001', role: 'CUSTOMER' as never,
    } as never)).rejects.toThrow('temporarily paused');

    expect(rateLimit.assertAllowed).not.toHaveBeenCalled();
    expect(otpCreate).not.toHaveBeenCalled();
  });

  it('register() refuses outright when paused, even with an otherwise-valid OTP code', async () => {
    const { service } = buildService('true');

    await expect(service.register({
      email: 'new@tracko.ng', phone: '+2348030000001', fullName: 'New User', password: 'password123', code: '123456', role: 'CUSTOMER' as never,
    } as never)).rejects.toThrow('temporarily paused');
  });

  it('is not gated when the setting is off, unset, or unreadable (fails open on a read error)', async () => {
    for (const pauseValue of ['false', null]) {
      const { service, findUnique } = buildService(pauseValue);
      await expect(service.register({
        email: 'new@tracko.ng', phone: '+2348030000001', fullName: 'New User', password: 'password123', code: '123456', role: 'CUSTOMER' as never,
      } as never)).rejects.not.toThrow('temporarily paused');
      expect(findUnique).toHaveBeenCalledWith({ where: { key: 'pauseRegistrations' } });
    }

    const throwingFindUnique = jest.fn().mockRejectedValue(new Error('connection reset'));
    const config = { get: () => undefined } as unknown as ConfigService;
    const prisma = {
      platformSetting: { findUnique: throwingFindUnique },
      otpCode: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const users = { findByEmailOrPhone: jest.fn().mockResolvedValue(null) } as unknown as UsersService;
    const service = new AuthService(config, {} as JwtService, prisma, { assertAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimitService, users);

    await expect(service.register({
      email: 'new@tracko.ng', phone: '+2348030000001', fullName: 'New User', password: 'password123', code: '123456', role: 'CUSTOMER' as never,
    } as never)).rejects.not.toThrow('temporarily paused');
  });
});

// refresh() previously never revoked the token it was given - every call just minted a
// new session, so a stolen refresh token stayed valid for its full 30-day lifetime no
// matter how many times the real user also refreshed. These tests pin down rotation
// (the presented token becomes unusable) and reuse detection (presenting an already-
// rotated token nukes every other active session, since that only happens if it leaked).
describe('AuthService.refresh rotates tokens and detects reuse', () => {
  function buildService(otpRow: { id: string; userId: string; revokedAt: Date | null; expiresAt: Date } | null) {
    const config = { get: () => undefined } as unknown as ConfigService;
    const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') } as unknown as JwtService;
    const prisma = {
      refreshToken: {
        findFirst: jest.fn().mockResolvedValue(otpRow),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      user: { findUnique: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const users = { findById: jest.fn().mockResolvedValue({ id: 'user-1', email: 'a@b.com', role: 'CUSTOMER', verificationStatus: 'VERIFIED' }) } as unknown as UsersService;
    const rateLimit = { assertAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
    return { service: new AuthService(config, jwt, prisma, rateLimit, users), prisma };
  }

  it('revokes the presented token as part of issuing a new session (rotation)', async () => {
    const row = { id: 'rt-1', userId: 'user-1', revokedAt: null, expiresAt: new Date(Date.now() + 1000 * 60 * 60) };
    const { service, prisma } = buildService(row);

    await service.refresh('some-refresh-token');

    expect((prisma.refreshToken.update as jest.Mock)).toHaveBeenCalledWith({ where: { id: 'rt-1' }, data: { revokedAt: expect.any(Date) } });
  });

  it('rejects an already-rotated (revoked) token and revokes every other active session for that user', async () => {
    const row = { id: 'rt-1', userId: 'user-1', revokedAt: new Date(), expiresAt: new Date(Date.now() + 1000 * 60 * 60) };
    const { service, prisma } = buildService(row);

    await expect(service.refresh('stolen-refresh-token')).rejects.toThrow();

    expect((prisma.refreshToken.updateMany as jest.Mock)).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    // A reuse attempt must never itself rotate/mint a new session.
    expect((prisma.refreshToken.update as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects an expired token without treating it as a reuse/theft signal', async () => {
    const row = { id: 'rt-1', userId: 'user-1', revokedAt: null, expiresAt: new Date(Date.now() - 1000) };
    const { service, prisma } = buildService(row);

    await expect(service.refresh('expired-refresh-token')).rejects.toThrow();
    expect((prisma.refreshToken.updateMany as jest.Mock)).not.toHaveBeenCalled();
  });
});

// SettingsService.requestAccountDeletion() (the in-app "Request account deletion" flow)
// only ever wrote an audit-log entry and notified staff - nothing anywhere called this
// method, so every reviewed deletion request went into a black hole no admin action could
// resolve. These tests pin down that an admin decision actually executes the deletion.
describe('AuthService.adminExecuteAccountDeletion', () => {
  function buildService(user: { id: string; isActive: boolean } | null) {
    const config = { get: () => undefined } as unknown as ConfigService;
    const jwt = {} as unknown as JwtService;
    const transaction = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue(undefined) },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      otpCode: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      profile: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const users = {} as unknown as UsersService;
    const rateLimit = {} as unknown as RateLimitService;
    return { service: new AuthService(config, jwt, prisma, rateLimit, users), prisma, transaction };
  }

  it('actually anonymizes the account via a real transaction, not just an audit-log note', async () => {
    const { service, transaction } = buildService({ id: 'user-1', isActive: true });

    const result = await service.adminExecuteAccountDeletion('user-1', 'admin-1', 'Confirmed by phone');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(true);
  });

  it('rejects executing deletion for an account that was already deleted', async () => {
    const { service, transaction } = buildService({ id: 'user-1', isActive: false });

    await expect(service.adminExecuteAccountDeletion('user-1', 'admin-1')).rejects.toThrow('already been deleted');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects executing deletion for an account that does not exist', async () => {
    const { service, transaction } = buildService(null);

    await expect(service.adminExecuteAccountDeletion('ghost-user', 'admin-1')).rejects.toThrow('not found');
    expect(transaction).not.toHaveBeenCalled();
  });
});

// This used to swallow a genuine OTP-row insert failure with only a "preview mode"
// comment - a leftover from before the OTP system was real - then proceed to claim
// `sent: true` and email a code out anyway. A real DB failure left new users with no
// valid OTP row to ever verify against: stuck unable to register, told it worked.
describe('AuthService.requestRegistrationCode never claims success when the OTP was not saved', () => {
  function buildService(otpCreate: jest.Mock) {
    const config = { get: jest.fn() } as unknown as ConfigService;
    const prisma = {
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      otpCode: { create: otpCreate },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const rateLimit = { assertAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
    const service = new AuthService(config, {} as JwtService, prisma, rateLimit, {} as UsersService);
    return { service };
  }

  it('throws instead of a fake "sent: true" when the OTP insert fails', async () => {
    const { service } = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.requestRegistrationCode({
      email: 'new@tracko.ng', phone: '+2348030000001', role: 'CUSTOMER' as never,
    } as never)).rejects.toThrow('Could not start registration');
  });

  it('still returns sent: true on genuine success', async () => {
    const { service } = buildService(jest.fn().mockResolvedValue(undefined));

    const result = await service.requestRegistrationCode({
      email: 'new@tracko.ng', phone: '+2348030000001', role: 'CUSTOMER' as never,
    } as never);

    expect(result.sent).toBe(true);
  });
});
