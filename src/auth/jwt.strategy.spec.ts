import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { UsersService } from '../users/users.service';
import { JwtStrategy } from './jwt.strategy';

const payload = {
  sub: 'user-1',
  email: 'old@tracko.ng',
  role: 'CUSTOMER' as const,
  verificationStatus: 'PENDING' as const,
};

function buildStrategy(user: Record<string, unknown> | null) {
  const config = { get: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService;
  const users = {
    findById: jest.fn().mockImplementation(() => user ? Promise.resolve(user) : Promise.reject(new Error('missing'))),
  } as unknown as UsersService;
  return new JwtStrategy(config, users);
}

describe('JwtStrategy', () => {
  it('refreshes mutable account details while preserving the selected portal role', async () => {
    const strategy = buildStrategy({
      id: 'user-1',
      email: 'current@tracko.ng',
      role: 'CUSTOMER',
      availableRoles: ['CUSTOMER', 'TRUCK_OWNER'],
      verificationStatus: 'VERIFIED',
      isActive: true,
    });

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      sub: 'user-1',
      role: 'CUSTOMER',
      email: 'current@tracko.ng',
      verificationStatus: 'VERIFIED',
    });
  });

  it.each([
    ['missing', null],
    ['inactive', { id: 'user-1', role: 'CUSTOMER', availableRoles: ['CUSTOMER'], verificationStatus: 'VERIFIED', isActive: false }],
    ['suspended', { id: 'user-1', role: 'CUSTOMER', availableRoles: ['CUSTOMER'], verificationStatus: 'SUSPENDED', isActive: true }],
  ])('rejects a %s account immediately', async (_label, user) => {
    await expect(buildStrategy(user).validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token for a role that has since been removed', async () => {
    const strategy = buildStrategy({
      id: 'user-1',
      email: 'current@tracko.ng',
      role: 'DRIVER',
      availableRoles: ['DRIVER'],
      verificationStatus: 'VERIFIED',
      isActive: true,
    });

    await expect(strategy.validate(payload)).rejects.toThrow('no longer has access');
  });
});
