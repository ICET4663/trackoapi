import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { KycProviderService } from './kyc-provider.service';
import type { PrismaService } from '../prisma/prisma.service';

const verifyMock = jest.fn();
const waitUntilCompleteMock = jest.fn();

jest.mock('@smileid/usesmileid-nodejs', () => ({
  SmileID: jest.fn().mockImplementation(() => ({
    enhancedKyc: { verify: verifyMock },
    verifications: { waitUntilComplete: waitUntilCompleteMock },
  })),
  Consent: { granted: jest.fn((args: unknown) => ({ granted: true, ...(args as object) })) },
}));

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

describe('KycProviderService.verifyIdentity (Smile ID Enhanced KYC)', () => {
  const smileEnv = {
    KYC_PROVIDER: 'smile_id',
    SMILE_ID_API_KEY: 'smile-key',
    SMILE_ID_PARTNER_ID: '1234',
    SMILE_ID_CALLBACK_URL: 'https://api.tracko.ng',
  };

  function buildService(envOverrides: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = { ...smileEnv, ...envOverrides };
    const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
    const executeRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const auditLogCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      auditLog: { create: auditLogCreate },
    } as unknown as PrismaService;
    return { service: new KycProviderService(config, prisma), executeRawUnsafe, auditLogCreate };
  }

  const baseInput = {
    submissionId: 'kyc-1',
    userId: 'user-1',
    fullName: 'Ada Customer',
    email: 'ada@tracko.ng',
    phone: '+2348012345678',
    idType: 'NIN',
    idNumber: '12345678901',
    bvn: null as string | null,
  };

  beforeEach(() => {
    verifyMock.mockReset();
    waitUntilCompleteMock.mockReset();
  });

  it('skips without throwing when Smile ID is not configured', async () => {
    const { service } = buildService({ SMILE_ID_API_KEY: undefined });

    const result = await service.verifyIdentity(baseInput);

    expect(result).toEqual({ ran: false, skippedReason: expect.stringContaining('not configured') });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('skips passport and driver licence submissions - not verifiable for Nigeria via Smile ID', async () => {
    const { service } = buildService();

    const result = await service.verifyIdentity({ ...baseInput, idType: 'DRIVERS_LICENCE', idNumber: 'DRV-000000' });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toContain("isn't available for DRIVERS_LICENCE");
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('skips when neither an email nor a phone number is on file', async () => {
    const { service } = buildService();

    const result = await service.verifyIdentity({ ...baseInput, email: null, phone: null });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toContain('email or phone');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('prefers BVN over the selected idType when both are present', async () => {
    const { service } = buildService();
    verifyMock.mockResolvedValue({ isAccepted: true, jobId: 'job-1', message: 'accepted' });

    await service.verifyIdentity({ ...baseInput, idType: 'DRIVERS_LICENCE', bvn: '10987654321' });

    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({
      country: 'NG',
      idType: 'BVN',
      idNumber: '10987654321',
      userId: 'user-1',
      partnerParams: { submissionId: 'kyc-1', userId: 'user-1' },
    }));
  });

  it('submits Enhanced KYC and persists the job id, leaving the decision to the webhook', async () => {
    const { service, executeRawUnsafe } = buildService();
    verifyMock.mockResolvedValue({ isAccepted: true, jobId: 'job-42', message: 'accepted' });

    const result = await service.verifyIdentity(baseInput);

    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({ country: 'NG', idType: 'NIN_V2', idNumber: '12345678901' }));
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('set "providerJobId" = $1'),
      'job-42',
      'kyc-1',
    );
    // Deliberately never awaits a synchronous decision here - see the comment on
    // verifyIdentity() about not blocking the KYC submission request on a poll that
    // could exceed the serverless function's own timeout. The webhook (tested below)
    // is the only path that ever sets `decision`.
    expect(result).toEqual({ ran: true, jobId: 'job-42', decision: null });
  });

  it('does not call verifications.waitUntilComplete - the webhook is the sole decision path', async () => {
    const { service } = buildService();
    verifyMock.mockResolvedValue({ isAccepted: true, jobId: 'job-43', message: 'accepted' });

    await service.verifyIdentity(baseInput);

    expect(waitUntilCompleteMock).not.toHaveBeenCalled();
  });

  it('never throws when the Smile ID submission itself fails, and records the failure', async () => {
    const { service, auditLogCreate } = buildService();
    verifyMock.mockRejectedValue(new Error('Insufficient wallet balance'));

    const result = await service.verifyIdentity(baseInput);

    expect(result).toEqual({ ran: false, error: 'Insufficient wallet balance' });
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'KYC_PROVIDER_SUBMIT_FAILED' }),
    }));
  });
});

describe('KycProviderService.recordWebhook (smile_id provider signature)', () => {
  const partnerId = '1234';
  const apiKey = 'smile-key';

  function sign(timestamp: string) {
    return createHmac('sha256', apiKey).update(`${timestamp}${partnerId}sid_request`).digest('base64');
  }

  function buildService(submissionUpdateResult: unknown = undefined) {
    const config = {
      get: jest.fn((key: string) => (key === 'SMILE_ID_PARTNER_ID' ? partnerId : key === 'SMILE_ID_API_KEY' ? apiKey : undefined)),
    } as unknown as ConfigService;
    const userUpdate = jest.fn().mockResolvedValue(undefined);
    const executeRawUnsafe = jest.fn().mockResolvedValue(submissionUpdateResult);
    const auditLogCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      user: { update: userUpdate },
      auditLog: { create: auditLogCreate },
    } as unknown as PrismaService;
    return { service: new KycProviderService(config, prisma), userUpdate, executeRawUnsafe };
  }

  const clearBody = {
    status: 'clear',
    message: 'Verification successful',
    reason: null,
    product: 'enhanced_kyc',
    partner_params: { submissionId: 'kyc-1', userId: 'user-1' },
  };

  it('rejects a webhook with no signature', async () => {
    const { service, userUpdate } = buildService();

    const result = await service.recordWebhook('smile_id', 'verification.completed', clearBody);

    expect(result.verified).toBe(false);
    expect(result.updated).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects a webhook with a wrong signature', async () => {
    const { service, userUpdate } = buildService();

    const result = await service.recordWebhook('smile_id', 'verification.completed', clearBody, undefined, '2026-01-01T00:00:00Z', 'wrong-signature');

    expect(result.verified).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('approves the user on a correctly-signed clear result', async () => {
    const { service, userUpdate } = buildService();
    const timestamp = '2026-01-01T00:00:00.000Z';

    const result = await service.recordWebhook('smile_id', 'verification.completed', clearBody, undefined, timestamp, sign(timestamp));

    expect(result.verified).toBe(true);
    expect(result.updated).toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { verificationStatus: 'VERIFIED' } });
  });

  it('requests correction rather than a hard rejection on a correctly-signed block result', async () => {
    const { service, userUpdate } = buildService();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const blockBody = { ...clearBody, status: 'block', message: 'ID not found', reason: 'invalid_id_number' };

    const result = await service.recordWebhook('smile_id', 'verification.completed', blockBody, undefined, timestamp, sign(timestamp));

    expect(result.verified).toBe(true);
    expect(result.updated).toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { verificationStatus: 'ACTION_NEEDED' } });
  });

  it('leaves the user untouched on an "attention" result - flags it for manual review instead', async () => {
    const { service, userUpdate } = buildService();
    const timestamp = '2026-01-01T00:00:00.000Z';
    const attentionBody = { ...clearBody, status: 'attention', message: 'Possible duplicate identity' };

    const result = await service.recordWebhook('smile_id', 'verification.completed', attentionBody, undefined, timestamp, sign(timestamp));

    expect(result.verified).toBe(true);
    expect(result.updated).toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
