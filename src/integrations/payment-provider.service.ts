import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type InitializeEscrowInput = {
  shipmentId?: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  customerEmail?: string;
};

@Injectable()
export class PaymentProviderService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  status() {
    const provider = this.config.get<string>('PAYMENT_PROVIDER') ?? 'mock';
    const hasPaystackKey = Boolean(this.config.get<string>('PAYSTACK_SECRET_KEY'));
    const hasStripeKey = Boolean(this.config.get<string>('STRIPE_SECRET_KEY'));

    return {
      provider,
      mode: hasPaystackKey || hasStripeKey ? 'configured' : 'mock',
      escrowEnabled: true,
      realChargeEnabled: hasPaystackKey || hasStripeKey,
      requiredEnv: provider === 'stripe' ? ['STRIPE_SECRET_KEY'] : ['PAYSTACK_SECRET_KEY'],
    };
  }

  async initializeEscrow(input: InitializeEscrowInput) {
    const shipmentId = input.shipmentId ?? `preview-shipment-${Date.now()}`;
    const currency = input.currency ?? 'NGN';
    const shipment = input.shipmentId
      ? await this.prisma.shipment.findUnique({
          where: { id: input.shipmentId },
          select: { id: true, customerId: true, quotedPriceKobo: true, cargoValueKobo: true },
        })
      : null;

    if (input.shipmentId && !shipment) {
      throw new BadRequestException('Shipment was not found for escrow payment.');
    }
    if (shipment && input.customerId && shipment.customerId !== input.customerId) {
      throw new ForbiddenException('This customer cannot fund escrow for this shipment.');
    }

    const amount = shipment?.quotedPriceKobo ?? shipment?.cargoValueKobo ?? input.amount ?? 0;
    if (!amount || amount <= 0) {
      throw new BadRequestException('A valid escrow amount is required.');
    }
    const providerReference = `tracko_escrow_${Date.now()}`;
    const status = this.status();

    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "Escrow" ("shipmentId", "amount", "currency", "status")
         values ($1, $2, $3, 'PENDING'::"EscrowStatus")
         on conflict ("shipmentId")
         do update set "amount" = excluded."amount", "currency" = excluded."currency", "updatedAt" = current_timestamp`,
        shipmentId,
        amount,
        currency,
      );
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'PENDING_PAYMENT',
          timeline: {
            create: {
              status: 'PENDING_PAYMENT',
              note: 'Escrow payment initialized.',
            },
          },
        },
      }).catch(() => null);
    } catch {
      // Keep preview usable until Supabase migrations are applied.
    }

    if (status.provider === 'paystack' && status.realChargeEnabled) {
      return this.initializePaystackEscrow({
        shipmentId,
        amount,
        currency,
        customerEmail: input.customerEmail,
        providerReference,
      });
    }

    return {
      provider: status.provider,
      mode: status.mode,
      shipmentId,
      amount,
      currency,
      providerReference,
      authorizationUrl: null,
      message:
        status.mode === 'mock'
          ? 'Mock escrow initialized. Add payment provider keys before charging real money.'
          : 'Provider credentials found. Connect the provider SDK/API in this service before live charges.',
    };
  }

  async recordWebhook(provider: string, event: string, body: unknown, signature?: string) {
    const verified =
      provider === 'paystack'
        ? this.verifyPaystackSignature(body, signature)
        : this.status().mode === 'mock';
    const payment = this.extractPaymentEvent(body);
    let escrowUpdated = false;

    if (verified && provider === 'paystack' && payment.shipmentId && payment.success) {
      try {
        await this.prisma.$queryRawUnsafe(
        `update "Escrow"
           set "status" = 'FUNDED'::"EscrowStatus",
               "amount" = coalesce($2, "amount"),
               "currency" = coalesce($3, "currency"),
               "updatedAt" = current_timestamp
           where "shipmentId" = $1`,
          payment.shipmentId,
          payment.amount,
          payment.currency,
        );
        await this.prisma.shipment.update({
          where: { id: payment.shipmentId },
          data: {
            status: 'ESCROW_FUNDED',
            timeline: {
              create: {
                status: 'ESCROW_FUNDED',
                note: `Escrow funded by ${provider}.`,
              },
            },
          },
        });
        escrowUpdated = true;
      } catch {
        escrowUpdated = false;
      }
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYMENT_WEBHOOK_RECEIVED',
          entity: 'PaymentProvider',
          entityId: payment.shipmentId,
          metadata: this.toJson({ provider, event, body, verified, payment, escrowUpdated }),
        },
      });
    } catch {
      // Preview fallback below.
    }

    return {
      received: true,
      provider,
      event,
      verified,
      escrowUpdated,
      processedAt: new Date().toISOString(),
    };
  }

  async verifyPaystackPayment(reference: string) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) {
      return {
        verified: false,
        provider: 'paystack',
        reference,
        escrowUpdated: false,
        message: 'Paystack key is missing.',
      };
    }

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
    });

    const payload = (await response.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: {
        status?: string;
        reference?: string;
        amount?: number;
        currency?: string;
        metadata?: { shipmentId?: string; purpose?: string };
      };
    };

    const payment = this.extractPaymentEvent({ event: 'charge.success', data: payload.data });
    const verified = Boolean(response.ok && payload.status && payload.data?.status === 'success');
    const escrowUpdated = verified && payment.shipmentId
      ? await this.markEscrowFunded(payment.shipmentId, payment.amount, payment.currency, 'paystack', payment.reference ?? reference)
      : false;

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYSTACK_PAYMENT_VERIFIED',
          entity: 'PaymentProvider',
          entityId: payment.shipmentId,
          metadata: this.toJson({ reference, verified, escrowUpdated, payload }),
        },
      });
    } catch {
      // Payment verification should not fail because audit logging is unavailable.
    }

    return {
      verified,
      provider: 'paystack',
      reference: payload.data?.reference ?? reference,
      shipmentId: payment.shipmentId,
      amount: payment.amount,
      currency: payment.currency,
      escrowUpdated,
      message: verified
        ? escrowUpdated
          ? 'Payment verified and escrow marked as funded.'
          : 'Payment verified, but escrow could not be updated automatically.'
        : payload.message ?? 'Payment could not be verified.',
    };
  }

  private async initializePaystackEscrow(input: {
    shipmentId: string;
    amount: number;
    currency: string;
    customerEmail?: string;
    providerReference: string;
  }) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) return this.mockProviderResponse(input, 'Paystack key is missing.');

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.customerEmail ?? this.config.get<string>('PAYMENT_FALLBACK_EMAIL') ?? 'payments@tracko.local',
        amount: input.amount,
        currency: input.currency,
        reference: input.providerReference,
        callback_url: this.paymentCallbackUrl(input.shipmentId, input.providerReference),
        metadata: {
          shipmentId: input.shipmentId,
          purpose: 'shipment_escrow',
        },
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; reference?: string; access_code?: string };
    };

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYSTACK_ESCROW_INITIALIZED',
          entity: 'Escrow',
          entityId: input.shipmentId,
          metadata: this.toJson({ ok: response.ok, payload }),
        },
      });
    } catch {
      // Preview audit fallback.
    }

    if (!response.ok || !payload.status) {
      return this.mockProviderResponse(input, payload.message ?? 'Paystack payment initialization failed.');
    }

    return {
      provider: 'paystack',
      mode: 'configured',
      shipmentId: input.shipmentId,
      amount: input.amount,
      currency: input.currency,
      providerReference: payload.data?.reference ?? input.providerReference,
      authorizationUrl: payload.data?.authorization_url ?? null,
      accessCode: payload.data?.access_code,
      message: 'Paystack escrow payment initialized. Redirect the customer to authorizationUrl.',
    };
  }

  private mockProviderResponse(input: { shipmentId: string; amount: number; currency: string; providerReference: string }, message: string) {
    return {
      provider: this.status().provider,
      mode: this.status().mode,
      shipmentId: input.shipmentId,
      amount: input.amount,
      currency: input.currency,
      providerReference: input.providerReference,
      authorizationUrl: null,
      message,
    };
  }

  private paymentCallbackUrl(shipmentId: string, reference: string) {
    const baseUrl = this.config.get<string>('PAYMENT_CALLBACK_URL');
    if (!baseUrl) return undefined;

    try {
      const url = new URL(baseUrl);
      url.searchParams.set('shipmentId', shipmentId);
      url.searchParams.set('reference', reference);
      return url.toString();
    } catch {
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}shipmentId=${encodeURIComponent(shipmentId)}&reference=${encodeURIComponent(reference)}`;
    }
  }

  private async markEscrowFunded(shipmentId: string, amount?: number, currency?: string, provider = 'paystack', reference?: string) {
    try {
      await this.prisma.$queryRawUnsafe(
        `update "Escrow"
         set "status" = 'FUNDED'::"EscrowStatus",
             "amount" = coalesce($2, "amount"),
             "currency" = coalesce($3, "currency"),
             "updatedAt" = current_timestamp
         where "shipmentId" = $1`,
        shipmentId,
        amount,
        currency,
      );
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'ESCROW_FUNDED',
          timeline: {
            create: {
              status: 'ESCROW_FUNDED',
              note: `Escrow funded by ${provider}.`,
            },
          },
        },
      });
      await this.recordSuccessfulPayment(shipmentId, amount, currency, provider, reference);
      return true;
    } catch {
      return false;
    }
  }

  private async recordSuccessfulPayment(shipmentId: string, amount?: number, currency = 'NGN', provider = 'paystack', reference?: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { customer: true },
    }).catch(() => null);

    if (!shipment) return;

    const amountKobo = Number(amount ?? shipment.quotedPriceKobo ?? 0);
    const ref = reference ?? `${provider}_${shipment.reference}`;
    const amountLabel = this.formatMoney(amountKobo, currency);

    await this.prisma.$executeRawUnsafe(
      `insert into "BillingCharge" ("id", "userId", "ref", "dateLabel", "amount")
       values ($1, $2, $3, $4, $5)
       on conflict ("id") do nothing`,
      `bill-${ref}`.slice(0, 120),
      shipment.customerId,
      shipment.reference,
      new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      amountLabel,
    ).catch(() => null);

    await Promise.all([
      this.notifications.create({
        userId: shipment.customerId,
        title: 'Escrow funded',
        body: `${amountLabel} has been secured for shipment ${shipment.reference}. Dispatch can now assign a driver.`,
        tone: 'SUCCESS',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: `/customer/shipment/${shipmentId}`,
      }),
      this.notifications.create({
        role: 'DISPATCHER',
        title: 'Shipment ready for assignment',
        body: `${shipment.reference} escrow is funded and ready for driver assignment.`,
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: '/dispatcher/assignment',
      }),
      this.notifications.create({
        role: 'ADMIN',
        title: 'Escrow payment received',
        body: `${shipment.reference} received ${amountLabel} through ${provider}.`,
        tone: 'SUCCESS',
        entity: 'Escrow',
        entityId: shipmentId,
        actionUrl: '/admin/finance',
      }),
    ]).catch(() => null);
  }

  private formatMoney(amountKobo?: number, currency = 'NGN') {
    const amount = Math.round(Number(amountKobo ?? 0) / 100).toLocaleString('en-US');
    return `${currency === 'NGN' ? 'N' : `${currency} `}${amount}`;
  }

  private verifyPaystackSignature(body: unknown, signature?: string) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey || !signature) return false;
    const digest = createHmac('sha512', secretKey).update(JSON.stringify(body ?? {})).digest('hex');
    return digest === signature;
  }

  private extractPaymentEvent(body: unknown) {
    const payload = (body ?? {}) as {
      event?: string;
      data?: {
        status?: string;
        reference?: string;
        amount?: number;
        currency?: string;
        metadata?: { shipmentId?: string; purpose?: string };
      };
    };
    return {
      success: payload.event === 'charge.success' || payload.data?.status === 'success',
      reference: payload.data?.reference,
      amount: typeof payload.data?.amount === 'number' ? payload.data.amount : undefined,
      currency: payload.data?.currency,
      shipmentId: payload.data?.metadata?.shipmentId,
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
