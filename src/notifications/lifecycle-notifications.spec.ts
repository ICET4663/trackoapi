import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { NotificationsService } from './notifications.service';
import { PaymentProviderService } from '../integrations/payment-provider.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { OperationsService } from '../operations/operations.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';
import type { PrismaService } from '../prisma/prisma.service';

// The payment, delivery and settlement steps that used to change state without telling
// the people affected: a failed payment, a refund, a completed shipment, the customer
// confirming receipt, a dispute, a cancelled trip and a payout that never arrived.

const parties = [{ customerId: 'cust-1', reference: 'TRK-7', driverId: 'driver-1' }];

function escrowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'escrow-1', shipmentId: 'shp-1', amount: 500_000, currency: 'NGN', status: 'FUNDED',
    arrivalConfirmed: false, proofOfDeliveryUploaded: false, customerDeliveryConfirmed: false,
    disputeWindowClear: false, platformApproved: false,
    ...overrides,
  };
}

describe('NotificationsService onceOnly', () => {
  it('skips an alert that was already sent for the same recipient, entity and title', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValueOnce([{ id: 'notif-earlier' }]);
    const service = new NotificationsService({ $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService);

    const result = await service.create({
      userId: 'cust-1', title: 'Payment declined', body: 'x', entity: 'Escrow', entityId: 'ref-1', onceOnly: true,
    });

    expect(result).toBeNull();
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe.mock.calls[0][0]).toContain('select "id" from "Notification"');
  });
});

describe('Unsuccessful Paystack payments notify the customer', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function buildService(transactionStatus: string, shipmentStatus = 'PENDING_PAYMENT') {
    const config = { get: jest.fn((key: string) => (key === 'PAYSTACK_SECRET_KEY' ? 'sk_test_fake' : undefined)) } as unknown as ConfigService;
    const prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1', reference: 'TRK-7', status: shipmentStatus }) },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: transactionStatus, reference: 'ref-9', amount: 500000, currency: 'NGN', metadata: { shipmentId: 'shp-1' } },
      }),
    });
    const notificationCreate = jest.fn().mockResolvedValue(null);
    const service = new PaymentProviderService(config, prisma, { create: notificationCreate } as unknown as NotificationsService);
    return { service, notificationCreate };
  }

  it('tells the customer once per payment reference when Paystack declines it, linking back to payment', async () => {
    const { service, notificationCreate } = buildService('failed');

    await service.verifyPaystackPayment('ref-9', { sub: 'cust-1', role: 'CUSTOMER' });

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cust-1',
      title: 'Payment declined',
      entityId: 'ref-9',
      actionUrl: '/customer/escrow?shipmentId=shp-1',
      onceOnly: true,
    }));
  });

  it('says nothing while a payment is still pending', async () => {
    const { service, notificationCreate } = buildService('pending');

    await service.verifyPaystackPayment('ref-9', { sub: 'cust-1', role: 'CUSTOMER' });

    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('says nothing when a later attempt already paid for the shipment', async () => {
    const { service, notificationCreate } = buildService('abandoned', 'ESCROW_FUNDED');

    await service.verifyPaystackPayment('ref-9', { sub: 'cust-1', role: 'CUSTOMER' });

    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('another customer checking the reference cannot trigger the alert', async () => {
    const { service, notificationCreate } = buildService('failed');

    await service.verifyPaystackPayment('ref-9', { sub: 'someone-else', role: 'CUSTOMER' });

    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe('A payout transfer that fails after "Withdrawal paid" tells the driver', () => {
  it('notifies the driver as well as admin', async () => {
    const secretKey = 'sk_test_fake_webhook_secret';
    const config = { get: jest.fn((key: string) => (key === 'PAYSTACK_SECRET_KEY' ? secretKey : undefined)) } as unknown as ConfigService;
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'payout-1', driverId: 'driver-1', amountKobo: 500_000 }]),
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const notificationCreate = jest.fn().mockResolvedValue(null);
    const service = new PaymentProviderService(config, prisma, { create: notificationCreate } as unknown as NotificationsService);
    const rawBody = JSON.stringify({ event: 'transfer.failed', data: { reference: 'payout-1-123', amount: 500_000 } });
    const signature = createHmac('sha512', secretKey).update(rawBody).digest('hex');

    await service.recordWebhook('paystack', 'charge.success', JSON.parse(rawBody), signature, rawBody);

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'driver-1', title: 'Withdrawal delayed', tone: 'WARNING', onceOnly: true,
    }));
  });
});

describe('Escrow refund, release and release checks notify the right people', () => {
  function buildService(currentEscrow: Record<string, unknown>, updatedEscrow?: Record<string, unknown>) {
    const queryRawUnsafe = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('from "Shipment" s where s."id"')) return Promise.resolve(parties);
      if (sql.includes('from "Escrow"') && sql.trim().startsWith('select')) return Promise.resolve([currentEscrow]);
      if (sql.includes('update "Escrow"')) return Promise.resolve(updatedEscrow ? [updatedEscrow] : []);
      return Promise.resolve([]);
    });
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      shipment: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ customerId: 'cust-1', assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }] }),
      },
      shipmentTimelineEvent: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const notificationCreate = jest.fn().mockResolvedValue(null);
    const service = new ShipmentsService(prisma, { create: notificationCreate } as unknown as NotificationsService, {} as MapsProviderService);
    return { service, notificationCreate, queryRawUnsafe };
  }

  it('refuses to refund escrow that was already released to the driver', async () => {
    const { service, notificationCreate } = buildService(escrowRow({ status: 'RELEASED' }));

    await expect(service.refundEscrow('shp-1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('a second refund changes nothing and sends nothing', async () => {
    const { service, notificationCreate, queryRawUnsafe } = buildService(escrowRow({ status: 'REFUNDED' }));

    await expect(service.refundEscrow('shp-1', 'ADMIN')).resolves.toEqual(expect.objectContaining({ status: 'REFUNDED' }));
    expect(queryRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining('update "Escrow"'), 'shp-1');
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('a refund tells the customer and the assigned driver', async () => {
    const { service, notificationCreate } = buildService(escrowRow(), escrowRow({ status: 'REFUNDED' }));

    await service.refundEscrow('shp-1', 'ADMIN');

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cust-1', title: 'Refund approved', body: expect.stringContaining('N5,000 for TRK-7'),
      actionUrl: '/customer/shipment/shp-1',
    }));
    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'driver-1', title: 'Shipment cancelled', actionUrl: '/driver/jobs',
    }));
  });

  it('releasing escrow tells the customer the shipment is complete', async () => {
    const ready = { status: 'RELEASE_READY', proofOfDeliveryUploaded: true, customerDeliveryConfirmed: true };
    const { service, notificationCreate } = buildService(escrowRow(ready), escrowRow({ ...ready, status: 'RELEASED' }));

    await service.releaseEscrow('shp-1', 'ADMIN');

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cust-1', title: 'Shipment completed', actionUrl: '/customer/shipment/shp-1',
    }));
  });

  it('the customer confirming receipt tells the driver and dispatch, once', async () => {
    const { service, notificationCreate } = buildService(
      escrowRow(),
      escrowRow({ customerDeliveryConfirmed: true, previousStatus: 'FUNDED', wasConfirmed: false }),
    );

    await service.confirmEscrowCheck('shp-1', 'customerDeliveryConfirmed', 'CUSTOMER', 'cust-1');

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'Customer confirmed delivery' }));
    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      role: 'DISPATCHER', title: 'Customer confirmed delivery', actionUrl: '/dispatcher/shipment/shp-1',
    }));
  });

  it('confirming receipt again sends nothing', async () => {
    const { service, notificationCreate } = buildService(
      escrowRow(),
      escrowRow({ customerDeliveryConfirmed: true, previousStatus: 'FUNDED', wasConfirmed: true }),
    );

    await service.confirmEscrowCheck('shp-1', 'customerDeliveryConfirmed', 'CUSTOMER', 'cust-1');

    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('the last release check prompts dispatch and admin to release the payment', async () => {
    const { service, notificationCreate } = buildService(
      escrowRow(),
      escrowRow({ status: 'RELEASE_READY', platformApproved: true, previousStatus: 'HELD', wasConfirmed: false }),
    );

    await service.confirmEscrowCheck('shp-1', 'platformApproved', 'ADMIN', 'admin-1');

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({ role: 'DISPATCHER', title: 'Escrow ready to release' }));
    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      role: 'ADMIN', title: 'Escrow ready to release', actionUrl: '/admin/shipment/shp-1',
    }));
  });
});

describe('Cancelling a trip tells the assigned driver', () => {
  function buildService() {
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-7', customerId: 'cust-1', status: 'DRIVER_ASSIGNED',
          assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'shp-1', reference: 'TRK-7', customerId: 'cust-1', status: 'CANCELLED', timeline: [] }),
      },
      driverAssignment: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue(parties),
    } as unknown as PrismaService;
    const notificationCreate = jest.fn().mockResolvedValue(null);
    const service = new ShipmentsService(prisma, { create: notificationCreate } as unknown as NotificationsService, {} as MapsProviderService);
    return { service, notificationCreate };
  }

  it('when the customer cancels', async () => {
    const { service, notificationCreate } = buildService();

    await service.updateStatus('shp-1', 'cust-1', 'CUSTOMER', { status: 'CANCELLED' } as never);

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', title: 'Shipment cancelled' }));
    expect(notificationCreate).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'cust-1' }));
  });

  // Owner rule, 14 October: cancelling refunds the customer, so drivers cannot cancel;
  // they ask operations to take them off the job. Nobody is alerted about a refused attempt.
  it('but a driver cannot cancel the shipment of a customer, and nobody is alerted', async () => {
    const { service, notificationCreate } = buildService();

    await expect(service.updateStatus('shp-1', 'driver-1', 'DRIVER', { status: 'CANCELLED' } as never)).rejects.toThrow('Only the customer or Trako operations');

    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe('Opening a dispute tells the other party their payment is on hold', () => {
  it('a customer\'s dispute alerts the driver, not the customer', async () => {
    const queryRawUnsafe = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('from "Shipment" s where s."id"')) return Promise.resolve([{ customerId: 'cust-1', driverId: 'driver-1' }]);
      return Promise.resolve([]);
    });
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      shipment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-7', customerId: 'cust-1', assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const notificationCreate = jest.fn().mockResolvedValue(null);
    const service = new OperationsService(prisma, { create: notificationCreate } as unknown as NotificationsService, {} as ShipmentsService);

    await service.createDispute({ shipmentId: 'TRK-7', reason: 'Cargo damaged' }, { sub: 'cust-1', role: 'CUSTOMER' });

    expect(notificationCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'driver-1', title: 'Dispute opened on your delivery', tone: 'WARNING',
    }));
    expect(notificationCreate).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'cust-1' }));
  });
});

describe('Only a shipment\'s own parties can open a dispute on it', () => {
  it('another customer cannot freeze this shipment\'s escrow', async () => {
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
      shipment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'shp-1', reference: 'TRK-7', customerId: 'cust-1', assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    const service = new OperationsService(prisma, { create: jest.fn() } as unknown as NotificationsService, {} as ShipmentsService);

    await expect(service.createDispute({ shipmentId: 'TRK-7', reason: 'x' }, { sub: 'cust-other', role: 'CUSTOMER' }))
      .rejects.toThrow('You do not have access to this shipment.');
    expect(queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('insert into "Dispute"'))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});
