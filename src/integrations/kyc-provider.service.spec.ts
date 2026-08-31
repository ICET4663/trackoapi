import { ConfigService } from '@nestjs/config';
import { KycProviderService } from './kyc-provider.service';
import type { PrismaService } from '../prisma/prisma.service';

// recordWebhook() had NO signature/secret verification at all - unlike the Paystack
// webhook right next to it in the same controller. Since it's a @Public() endpoint that
// flips User.verificationStatus straight to VERIFIED based only on the request body,
// anyone who could reach the API could KYC-approve any account, bypassing identity
// verification (and the KYC gate on funding escrow) entirely.
describe('KycProviderService.recordWebhook is actually secured', () => {
  const secret = 'kyc-webhook-shared-secret';

  function buildService(userUpdate: jest.Mock, submissionRows: unknown[] = [{ id: 'sub-1', userId: 'user-1' }]) {
    const config = {
      get: jest.fn((key: string) => (key === 'KYC_WEBHOOK_SECRET' ? secret : undefined)),
    } as unknown as ConfigService;
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue(submissionRows),
      user: { update: userUpdate },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    return new KycProviderService(config, prisma);
  }

  const approvedBody = { userId: 'user-1', status: 'approved' };

  it('does not verify anyone when no secret is presented', async () => {
    const userUpdate = jest.fn();
    const service = buildService(userUpdate);

    const result = await service.recordWebhook('dojah', 'verification.completed', approvedBody);

    expect(result.verified).toBe(false);
    expect(result.updated).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('does not verify anyone when the wrong secret is presented', async () => {
    const userUpdate = jest.fn();
    const service = buildService(userUpdate);

    const result = await service.recordWebhook('dojah', 'verification.completed', approvedBody, 'wrong-secret');

    expect(result.verified).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects a same-length but wrong secret without throwing (timingSafeEqual would throw on a raw length mismatch elsewhere)', async () => {
    const userUpdate = jest.fn();
    const service = buildService(userUpdate);
    const tampered = `${secret.slice(0, -1)}!`;

    const result = await service.recordWebhook('dojah', 'verification.completed', approvedBody, tampered);

    expect(result.verified).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('flips verificationStatus to VERIFIED only when the correct secret is presented', async () => {
    const userUpdate = jest.fn().mockResolvedValue(undefined);
    const service = buildService(userUpdate);

    const result = await service.recordWebhook('dojah', 'verification.completed', approvedBody, secret);

    expect(result.verified).toBe(true);
    expect(result.updated).toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { verificationStatus: 'VERIFIED' } });
  });

  it('never verifies anything when KYC_WEBHOOK_SECRET is not configured, even with a secret presented', async () => {
    const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const userUpdate = jest.fn();
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'sub-1', userId: 'user-1' }]),
      user: { update: userUpdate },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const service = new KycProviderService(config, prisma);

    const result = await service.recordWebhook('dojah', 'verification.completed', approvedBody, 'anything');

    expect(result.verified).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
