import type { Request } from 'express';
import { DemoReadinessController } from './demo-readiness.controller';
import type { DeploymentConfigService } from './config/deployment-config.service';
import type { PrismaService } from './prisma/prisma.service';

describe('DemoReadinessController', () => {
  const deploymentConfig = {
    summary: jest.fn(() => ({
      environment: 'production',
      required: { ok: true, missing: [] },
      integrations: [
        { name: 'payments', mode: 'configured' },
        { name: 'kyc', mode: 'mock' },
        { name: 'maps', mode: 'configured' },
        { name: 'email', mode: 'configured' },
      ],
    })),
    emailDomainStatus: jest.fn(async () => ({
      checked: true,
      keyConfigured: true,
      verifiedDomains: ['updates.trako.com.ng'],
      pendingDomains: [],
      message: 'verified',
    })),
    storageStatus: jest.fn(async () => ({
      checked: true,
      urlConfigured: true,
      keyConfigured: true,
      bucketExists: true,
      bucket: 'tracko-media',
      urlHost: 'example.supabase.co',
      message: 'connected',
    })),
  } as unknown as DeploymentConfigService;

  const prisma = {
    $queryRawUnsafe: jest.fn(async () => [{ connected: 1 }]),
  } as unknown as PrismaService;

  it('publishes deployment-specific webhook and frontend API URLs', async () => {
    const controller = new DemoReadinessController(deploymentConfig, prisma);
    const request = {
      protocol: 'http',
      headers: { 'x-forwarded-proto': 'https' },
      get: jest.fn((name: string) => name === 'host' ? 'trackoapi.vercel.app' : undefined),
    } as unknown as Request;

    const result = await controller.readiness(request);

    expect(result.escrowPayment.paystackWebhookUrl).toBe(
      'https://trackoapi.vercel.app/v1/payments/webhooks/paystack/charge.success',
    );
    expect(result.frontendConnection).toEqual({
      requiredEnv: 'EXPO_PUBLIC_API_BASE_URL=https://trackoapi.vercel.app/v1',
      status: 'ready',
    });
  });
});
