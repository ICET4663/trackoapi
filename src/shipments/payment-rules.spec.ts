import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ShipmentsService } from './shipments.service';
import { PaymentProviderService } from '../integrations/payment-provider.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// Owner decisions, 14 October: (1) payment is never released before proof of delivery, and
// without the customer's confirmation (or a resolved dispute) only an admin may release,
// with a reason; (2) a paid shipment cancelled before pickup is refunded in full through
// Paystack, with no fee; drivers cannot cancel a customer's shipment.
describe('Payment release rules', () => {
  const escrow = (overrides: Record<string, unknown> = {}) => ({
    id: 'esc-1', shipmentId: 'shp-1', amount: 10_000_000, currency: 'NGN', status: 'FUNDED',
    arrivalConfirmed: true, proofOfDeliveryUploaded: true, customerDeliveryConfirmed: false,
    disputeWindowClear: false, platformApproved: false, ...overrides,
  });

  function build(row: Record<string, unknown>, resolvedDispute = false) {
    const queryRawUnsafe = jest.fn((sql: string) => {
      if (sql.includes('from "Dispute"')) return Promise.resolve(resolvedDispute ? [{ id: 'dsp-1' }] : []);
      if (sql.includes('update "Escrow"')) return Promise.resolve([{ ...row, status: 'RELEASED' }]);
      if (sql.includes('from "Escrow"')) return Promise.resolve([row]);
      return Promise.resolve([]);
    });
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService);
    const internals = service as unknown as Record<string, unknown>;
    for (const name of ['updateShipmentTimeline', 'notifyAssignedDriverOfEscrowRelease', 'notifyShipmentParties']) {
      jest.spyOn(internals as never, name as never).mockResolvedValue(undefined as never);
    }
    return { service, released: () => queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('update "Escrow"')) };
  }

  it('refuses to release before proof of delivery, even for an admin', async () => {
    const { service, released } = build(escrow({ proofOfDeliveryUploaded: false, customerDeliveryConfirmed: true }));

    await expect(service.releaseEscrow('shp-1', 'ADMIN', 'Releasing early for a good reason')).rejects.toBeInstanceOf(BadRequestException);
    expect(released()).toBe(false);
  });

  it('releases once the customer has confirmed delivery', async () => {
    const { service, released } = build(escrow({ customerDeliveryConfirmed: true }));

    await expect(service.releaseEscrow('shp-1', 'DISPATCHER')).resolves.toMatchObject({ status: 'RELEASED' });
    expect(released()).toBe(true);
  });

  it('a dispatcher cannot release before the customer confirms', async () => {
    const { service, released } = build(escrow());

    await expect(service.releaseEscrow('shp-1', 'DISPATCHER', 'Driver says it was delivered')).rejects.toBeInstanceOf(ForbiddenException);
    expect(released()).toBe(false);
  });

  it('an admin must give a reason to release before the customer confirms', async () => {
    const { service, released } = build(escrow());

    await expect(service.releaseEscrow('shp-1', 'ADMIN')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.releaseEscrow('shp-1', 'ADMIN', 'ok')).rejects.toBeInstanceOf(BadRequestException);
    expect(released()).toBe(false);
  });

  it('an admin can release before confirmation with a reason (also how the 3-day auto-release runs)', async () => {
    const { service, released } = build(escrow());

    await expect(service.releaseEscrow('shp-1', 'ADMIN', 'Customer unreachable for 3 days; proof checked')).resolves.toMatchObject({ status: 'RELEASED' });
    expect(released()).toBe(true);
  });

  it('a resolved dispute lets operations release without the customer confirming', async () => {
    const { service, released } = build(escrow(), true);

    await expect(service.releaseEscrow('shp-1', 'DISPATCHER', 'Dispute resolved for the driver')).resolves.toMatchObject({ status: 'RELEASED' });
    expect(released()).toBe(true);
  });
});

describe('Cancellation and refunds', () => {
  function build({ status = 'DRIVER_EN_ROUTE', escrowStatus = 'FUNDED', customerId = 'cust-1' } = {}) {
    const shipment = { id: 'shp-1', reference: 'TRK-1', customerId, status, assignments: [{ driverId: 'driver-1', status: 'ACCEPTED' }] };
    const prisma = {
      shipment: {
        findUnique: jest.fn().mockResolvedValue(shipment),
        update: jest.fn().mockResolvedValue({ ...shipment, status: 'CANCELLED', timeline: [] }),
      },
      $queryRawUnsafe: jest.fn((sql: string) => Promise.resolve(
        sql.includes('update "Escrow"') ? [{ id: 'esc-1', shipmentId: 'shp-1', amount: 10_000_000, currency: 'NGN', status: 'REFUNDED' }]
          : sql.includes('from "Escrow"') ? [{ id: 'esc-1', shipmentId: 'shp-1', amount: 10_000_000, currency: 'NGN', status: escrowStatus }]
            : [],
      )),
    } as unknown as PrismaService;
    const refundShipmentPayment = jest.fn().mockResolvedValue({ status: 'pending', detail: 'Paystack refund pending.' });
    const service = new ShipmentsService(prisma, {} as NotificationsService, {} as MapsProviderService, { refundShipmentPayment } as unknown as PaymentProviderService);
    const internals = service as unknown as Record<string, unknown>;
    for (const name of ['activateQueuedOffers', 'notifyShipmentParties', 'updateShipmentTimeline']) {
      jest.spyOn(internals as never, name as never).mockResolvedValue(undefined as never);
    }
    jest.spyOn(internals as never, 'toShipmentRecord' as never).mockReturnValue({ id: 'shp-1', status: 'CANCELLED' } as never);
    const refundEscrow = jest.spyOn(service, 'refundEscrow');
    return { service, refundEscrow, refundShipmentPayment };
  }

  it('a customer cancelling a paid shipment before pickup gets a full refund through Paystack', async () => {
    const { service, refundEscrow, refundShipmentPayment } = build();

    await service.updateStatus('shp-1', 'cust-1', 'CUSTOMER', { status: 'CANCELLED' } as never);
    expect(refundEscrow).toHaveBeenCalledWith('shp-1', 'ADMIN', expect.stringContaining('full refund, no fee'));
    expect(refundShipmentPayment).toHaveBeenCalledWith('shp-1');
  });

  it('an unpaid shipment is cancelled without a refund', async () => {
    const { service, refundEscrow } = build({ status: 'QUOTED', escrowStatus: 'PENDING' });

    await service.updateStatus('shp-1', 'cust-1', 'CUSTOMER', { status: 'CANCELLED' } as never);
    expect(refundEscrow).not.toHaveBeenCalled();
  });

  it('the assigned driver cannot cancel the customer\'s shipment', async () => {
    const { service, refundEscrow } = build();

    await expect(service.updateStatus('shp-1', 'driver-1', 'DRIVER', { status: 'CANCELLED' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(refundEscrow).not.toHaveBeenCalled();
  });
});

describe('PaymentProviderService.refundShipmentPayment', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function build(env: Record<string, string | undefined>, billingId: string | null = 'bill-trk_ref_123') {
    const prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ reference: 'TRK-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue(billingId ? [{ id: billingId }] : []),
    } as unknown as PrismaService;
    const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
    return new PaymentProviderService(config, prisma, {} as NotificationsService);
  }
  const paystack = { PAYMENT_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_x' };

  it('asks Paystack to refund the shipment\'s charge', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: true, data: { status: 'pending' } }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(build(paystack).refundShipmentPayment('shp-1')).resolves.toMatchObject({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.paystack.co/refund', expect.objectContaining({ method: 'POST', body: JSON.stringify({ transaction: 'trk_ref_123' }) }));
  });

  it('treats an already-refunded charge as refunded', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ status: false, message: 'Transaction has been fully reversed' }) }) as unknown as typeof fetch;

    await expect(build(paystack).refundShipmentPayment('shp-1')).resolves.toMatchObject({ status: 'refunded' });
  });

  it('does nothing without Paystack configured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(build({}).refundShipmentPayment('shp-1')).resolves.toMatchObject({ status: 'not_applicable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failure when no payment reference is on record', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    await expect(build(paystack, null).refundShipmentPayment('shp-1')).resolves.toMatchObject({ status: 'failed' });
  });
});
