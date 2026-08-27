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
