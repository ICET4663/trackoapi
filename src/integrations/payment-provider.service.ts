import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type InitializeEscrowInput = {
  shipmentId?: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  customerEmail?: string;
  method?: 'card' | 'bank_transfer';
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
      webhookSignatureVerification: provider === 'paystack' ? 'raw-body-hmac-sha512' : 'provider-dependent',
      webhookPath: provider === 'paystack' ? '/v1/payments/webhooks/paystack/charge.success' : '/v1/payments/webhooks/:provider/:event',
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
    if (input.customerId) {
      const [customer] = await this.prisma.$queryRawUnsafe<Array<{ verificationStatus: string }>>(
        'select "verificationStatus"::text as "verificationStatus" from "User" where "id" = $1 limit 1',
        input.customerId,
      );
      // Fails closed: `customer` coming back empty (no matching User row for a customerId
      // the caller supplied) must be treated the same as "not verified", not silently
      // skipped - the original `customer && ...` check let an unresolvable customerId
      // bypass the KYC gate entirely instead of rejecting it.
      if (!customer || customer.verificationStatus !== 'VERIFIED') {
        throw new BadRequestException('Complete KYC approval before funding escrow.');
      }
    }

    const amount = shipment?.quotedPriceKobo ?? shipment?.cargoValueKobo ?? input.amount ?? 0;
    if (!amount || amount <= 0) {
      throw new BadRequestException('A valid escrow amount is required.');
    }
    const providerReference = `tracko_escrow_${Date.now()}`;
    const status = this.status();

    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "Escrow" ("id", "shipmentId", "amount", "currency", "status", "updatedAt")
         values ($1, $2, $3, $4, 'PENDING'::"EscrowStatus", current_timestamp)
         on conflict ("shipmentId")
         do update set "amount" = excluded."amount", "currency" = excluded."currency", "updatedAt" = current_timestamp`,
        `escrow-${shipmentId}`,
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
      // Escrow bookkeeping is best-effort here; the real charge is still initialized with
      // the provider below regardless. (This used to swallow a guaranteed NOT NULL violation
      // on "updatedAt" - now fixed above - so this row was never actually being created.)
    }

    if (status.provider === 'paystack' && status.realChargeEnabled) {
      return this.initializePaystackEscrow({
        shipmentId,
        amount,
        currency,
        customerEmail: input.customerEmail,
        providerReference,
        method: input.method,
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

  async recordWebhook(provider: string, event: string, body: unknown, signature?: string, rawBody?: Buffer | string) {
    const verified =
      provider === 'paystack'
        ? this.verifyPaystackSignature(body, signature, rawBody)
        : this.status().mode === 'mock';
    const payment = this.extractPaymentEvent(body);
    let escrowUpdated = false;
    // A charge.success event can arrive more than once (Paystack retries on
    // timeout, and the client-side verify() call can race the webhook). Treat
    // this as already-processed rather than re-crediting/re-notifying.
    let alreadyProcessed = false;

    if (verified && provider === 'paystack' && payment.shipmentId && payment.success) {
      const currentStatus = await this.escrowStatus(payment.shipmentId);
      if (currentStatus && currentStatus !== 'PENDING') {
        alreadyProcessed = true;
        escrowUpdated = true;
      } else {
        escrowUpdated = await this.markEscrowFunded(
          payment.shipmentId,
          payment.amount,
          payment.currency,
          provider,
          payment.reference,
        );
        if (escrowUpdated) await this.savePaymentMethodFromAuthorization(payment.shipmentId, payment.authorization);
      }
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'PAYMENT_WEBHOOK_RECEIVED',
          entity: 'PaymentProvider',
          entityId: payment.shipmentId,
          metadata: this.toJson({ provider, event, body, verified, payment, escrowUpdated, alreadyProcessed }),
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
      alreadyProcessed,
      processedAt: new Date().toISOString(),
    };
  }

  private async escrowStatus(shipmentId: string): Promise<string | null> {
    try {
      const [row] = await this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
        'select "status"::text as "status" from "Escrow" where "shipmentId" = $1 limit 1',
        shipmentId,
      );
      return row?.status ?? null;
    } catch {
      return null;
    }
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
        authorization?: {
          authorization_code?: string;
          card_type?: string;
          bank?: string;
          last4?: string;
          exp_month?: string;
          exp_year?: string;
          channel?: string;
          reusable?: boolean;
        };
      };
    };

    const payment = this.extractPaymentEvent({ event: 'charge.success', data: payload.data });
    const verified = Boolean(response.ok && payload.status && payload.data?.status === 'success');
    const escrowUpdated = verified && payment.shipmentId
      ? await this.markEscrowFunded(payment.shipmentId, payment.amount, payment.currency, 'paystack', payment.reference ?? reference)
      : false;
    if (escrowUpdated && payment.shipmentId) await this.savePaymentMethodFromAuthorization(payment.shipmentId, payment.authorization);

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
    method?: 'card' | 'bank_transfer';
  }) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey) return this.mockProviderResponse(input, 'Paystack key is missing.');

    // Paystack's hosted checkout offers every channel enabled on the account when no
    // `channels` filter is sent. Narrowing it here makes the customer's in-app method
    // choice actually mean something, instead of it being a purely cosmetic selector
    // that Paystack's own page would ignore anyway.
    const channels =
      input.method === 'card'
        ? ['card']
        : input.method === 'bank_transfer'
          ? ['bank_transfer', 'bank', 'ussd']
          : undefined;

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
        ...(channels ? { channels } : {}),
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

  private verifyPaystackSignature(body: unknown, signature?: string, rawBody?: Buffer | string) {
    const secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey || !signature) return false;
    const payload = rawBody ?? JSON.stringify(body ?? {});
    const digest = createHmac('sha512', secretKey).update(payload).digest('hex');
    // This endpoint decides whether escrow gets marked funded - a plain `===` string
    // comparison leaks timing information about how many leading characters of the digest
    // matched, byte by byte, which is exactly the kind of side channel a constant-time
    // comparison exists to close (the same fix already applied to quote-token
    // verification elsewhere in this codebase). Node's Buffer.from(str, 'hex') silently
    // truncates at the first invalid hex character rather than throwing, so an
    // attacker-supplied signature that isn't valid hex safely fails the length check below
    // instead of ever reaching timingSafeEqual (which throws on mismatched lengths).
    const suppliedBuffer = Buffer.from(signature, 'hex');
    const digestBuffer = Buffer.from(digest, 'hex');
    return suppliedBuffer.length === digestBuffer.length && timingSafeEqual(suppliedBuffer, digestBuffer);
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
        authorization?: {
          authorization_code?: string;
          card_type?: string;
          bank?: string;
          last4?: string;
          exp_month?: string;
          exp_year?: string;
          channel?: string;
          reusable?: boolean;
        };
      };
    };
    return {
      success: payload.event === 'charge.success' || payload.data?.status === 'success',
      reference: payload.data?.reference,
      amount: typeof payload.data?.amount === 'number' ? payload.data.amount : undefined,
      currency: payload.data?.currency,
      shipmentId: payload.data?.metadata?.shipmentId,
      authorization: payload.data?.authorization,
    };
  }

  // Paystack's own flow for "saving a card": a successful card charge with
  // reusable=true returns an authorization_code good for future off-session charges.
  // There's no separate "add a card without paying" API - so the customer's card is
  // saved automatically the first time they fund escrow with one, same as most apps
  // built on Paystack. Bank transfer/USSD charges are not reusable, so those never
  // create a saved "payment method" here.
  private async savePaymentMethodFromAuthorization(
    shipmentId: string,
    authorization?: {
      authorization_code?: string;
      card_type?: string;
      bank?: string;
      last4?: string;
      exp_month?: string;
      exp_year?: string;
      channel?: string;
      reusable?: boolean;
    },
  ) {
    if (!authorization?.reusable || !authorization.authorization_code || authorization.channel !== 'card') return;

    try {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId }, select: { customerId: true } });
      if (!shipment) return;

      const detail = `auth:${authorization.authorization_code}`;
      const existing = await this.prisma.paymentMethod.findFirst({ where: { userId: shipment.customerId, detail } });
      if (existing) return;

      const isFirstMethod = (await this.prisma.paymentMethod.count({ where: { userId: shipment.customerId } })) === 0;

      await this.prisma.paymentMethod.create({
        data: {
          userId: shipment.customerId,
          brand: authorization.card_type ?? authorization.bank ?? 'Card',
          maskedNumber: authorization.last4 ? `**** ${authorization.last4}` : '****',
          detail,
          type: 'CARD',
          isDefault: isFirstMethod,
          expiry: authorization.exp_month && authorization.exp_year ? `${authorization.exp_month}/${authorization.exp_year.slice(-2)}` : undefined,
        },
      });
    } catch {
      // Saving the card for reuse is a convenience on top of a successful payment -
      // the escrow funding itself must not be treated as failed if this part errors.
    }
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
