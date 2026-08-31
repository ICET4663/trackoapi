import { ConfigService } from '@nestjs/config';
import { KycService } from './kyc.service';
import type { PrismaService } from '../prisma/prisma.service';

// previewEnabled() used to fall back to "NODE_ENV isn't production" - the exact pattern
// already identified as dangerous and fixed for exposeDevOtp() in auth.service.ts, since
// NODE_ENV being merely unset/misconfigured on a real deployment is enough to trigger it.
// Every KYC method (submit, attachDocument, queue, review, decide) silently faked success
// on any DB failure under that condition - for decide() specifically, an admin could
// believe they'd rejected a fraudulent submission when nothing was actually persisted.
describe('KycService preview fallback requires the explicit flag only', () => {
  function buildService(configOverrides: Record<string, string | undefined>, executeRawUnsafe: jest.Mock) {
    const config = {
      get: jest.fn((key: string) => configOverrides[key]),
    } as unknown as ConfigService;
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    return new KycService(config, prisma);
  }

  it('decide() throws a real error when NODE_ENV is merely unset/non-production and ENABLE_PREVIEW_AUTH is not set', async () => {
    const service = buildService({ NODE_ENV: undefined }, jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.decide('user-1', { action: 'REJECT', note: 'blurry ID' }, 'admin-1')).rejects.toThrow('connection reset');
  });

  it('decide() throws a real error even when NODE_ENV is explicitly "development"', async () => {
    const service = buildService({ NODE_ENV: 'development' }, jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.decide('user-1', { action: 'APPROVE' }, 'admin-1')).rejects.toThrow('connection reset');
  });

  it('decide() still falls back to a preview response when ENABLE_PREVIEW_AUTH=true is explicitly set', async () => {
    const service = buildService(
      { NODE_ENV: 'development', ENABLE_PREVIEW_AUTH: 'true' },
      jest.fn().mockRejectedValue(new Error('connection reset')),
    );

    const result = await service.decide('user-1', { action: 'APPROVE' }, 'admin-1');

    expect(result).toBeDefined();
  });

  it('submit() throws a real error instead of a fake submission when NODE_ENV is unset', async () => {
    const service = buildService({ NODE_ENV: undefined }, jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.submit({ role: 'CUSTOMER', idType: 'NIN', idNumber: '12345678901' }, 'user-1', 'CUSTOMER'))
      .rejects.toThrow('connection reset');
  });
});
