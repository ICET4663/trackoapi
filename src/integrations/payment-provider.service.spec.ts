import { ConfigService } from '@nestjs/config';
import { PaymentProviderService } from './payment-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// The "Payment method" selector in the app used to be cosmetic - Paystack's hosted
// checkout shows every channel enabled on the account regardless of what's picked
// in-app, since no `channels` filter was ever sent. These tests pin down that the
// customer's selection now actually narrows what Paystack's checkout page offers.
describe('PaymentProviderService.initializeEscrow - Paystack channel selection', () => {
  let config: { get: jest.Mock };
  let prisma: {
    shipment: { findUnique: jest.Mock; update: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };
  let notifications: NotificationsService;
  let service: PaymentProviderService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) => {
        if (key === 'PAYMENT_PROVIDER') return 'paystack';
        if (key === 'PAYSTACK_SECRET_KEY') return 'sk_test_fake';
        return undefined;
      }),
    };
    prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue(undefined) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    };
    notifications = {} as NotificationsService;
    service = new PaymentProviderService(config as unknown as ConfigService, prisma as unknown as PrismaService, notifications);

    fetchMock = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { authorization_url: 'https://paystack.test/checkout', reference: 'ref-1' } }),
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  function paystackRequestBody() {
    const [, requestInit] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(requestInit.body);
  }

  it('sends channels: ["card"] when the customer picks card', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN', method: 'card' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.paystack.co/transaction/initialize', expect.anything());
    expect(paystackRequestBody().channels).toEqual(['card']);
  });

  it('sends bank/ussd/bank_transfer channels when the customer picks bank_transfer', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN', method: 'bank_transfer' });

    expect(paystackRequestBody().channels).toEqual(['bank_transfer', 'bank', 'ussd']);
  });

  it('omits channels entirely when no method is specified, letting Paystack show everything enabled on the account', async () => {
    await service.initializeEscrow({ amount: 500000, currency: 'NGN' });

    expect(paystackRequestBody().channels).toBeUndefined();
  });
});
