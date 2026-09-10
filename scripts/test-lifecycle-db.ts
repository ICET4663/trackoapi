import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { AuthService } from '../src/auth/auth.service';
import { MapsProviderService } from '../src/integrations/maps-provider.service';
import { PaymentProviderService } from '../src/integrations/payment-provider.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';
import { ShipmentsService } from '../src/shipments/shipments.service';
import { TrackingService } from '../src/tracking/tracking.service';

const baseDatabaseUrl = (() => {
  const value = process.env.TEST_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL is required. Point it to a dedicated local/test PostgreSQL database, never production Supabase.',
    );
  }
  return value;
})();

function assertSafeTestDatabase(url: string) {
  const parsed = new URL(url);
  const normalized = url.toLowerCase();
  const databaseName = parsed.pathname.replace(/^\//, '').toLowerCase();
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const explicitlyTestNamed = /(^|[-_])(test|testing)([-_]|$)/.test(databaseName);

  if (normalized.includes('supabase.co') || normalized === (process.env.DATABASE_URL ?? '').toLowerCase()) {
    throw new Error('Refusing to run lifecycle tests against Supabase or the configured application database.');
  }
  if (!isLocal && !explicitlyTestNamed) {
    throw new Error('Remote TEST_DATABASE_URL database names must contain "test" or "testing".');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL connection string.');
  }
}

function withSchema(url: string, schema: string) {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

function expectValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Lifecycle assertion failed: ${message}`);
}

async function main() {
  assertSafeTestDatabase(baseDatabaseUrl);
  const schema = `tracko_lifecycle_${Date.now()}_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const adminUrl = withSchema(baseDatabaseUrl, 'public');
  const lifecycleUrl = withSchema(baseDatabaseUrl, schema);
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  let prisma: PrismaService | undefined;

  console.log(`Tracko database lifecycle: temporary schema ${schema}`);
  try {
    await admin.$executeRawUnsafe(`create schema "${schema}"`);
    process.env.DATABASE_URL = lifecycleUrl;
    const prismaCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execFileSync(prismaCommand, ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: lifecycleUrl },
      stdio: 'inherit',
    });

    prisma = new PrismaService();
    const notifications = new NotificationsService(prisma);
    const config = new ConfigService({
      PAYMENT_PROVIDER: 'mock',
      PAYSTACK_SECRET_KEY: 'sk_test_lifecycle_only',
      QUOTE_SIGNING_SECRET: 'lifecycle-quote-secret',
    });
    const maps = new MapsProviderService(config, prisma);
    const shipments = new ShipmentsService(prisma, notifications, maps);
    const tracking = new TrackingService(prisma, notifications);
    const payments = new PaymentProviderService(config, prisma, notifications);
    const settings = new SettingsService(prisma, notifications, config, {} as AuthService);

    const suffix = randomUUID().slice(0, 8);
    const [customer, driver, dispatcher, adminUser] = await Promise.all([
      prisma.user.create({ data: { email: `customer-${suffix}@test.trako.com.ng`, phone: `+2348100${suffix.slice(0, 6)}`, passwordHash: 'test-only', role: 'CUSTOMER', availableRoles: ['CUSTOMER'], verificationStatus: 'VERIFIED', profile: { create: { fullName: 'Lifecycle Customer' } } } }),
      prisma.user.create({ data: { email: `driver-${suffix}@test.trako.com.ng`, phone: `+2348200${suffix.slice(0, 6)}`, passwordHash: 'test-only', role: 'DRIVER', availableRoles: ['DRIVER'], verificationStatus: 'VERIFIED', profile: { create: { fullName: 'Lifecycle Driver' } }, safetySettings: { create: { availableForAssignments: true } } } }),
      prisma.user.create({ data: { email: `dispatcher-${suffix}@test.trako.com.ng`, phone: `+2348300${suffix.slice(0, 6)}`, passwordHash: 'test-only', role: 'DISPATCHER', availableRoles: ['DISPATCHER'], verificationStatus: 'VERIFIED', profile: { create: { fullName: 'Lifecycle Dispatcher' } } } }),
      prisma.user.create({ data: { email: `admin-${suffix}@test.trako.com.ng`, phone: `+2348400${suffix.slice(0, 6)}`, passwordHash: 'test-only', role: 'ADMIN', availableRoles: ['ADMIN'], verificationStatus: 'VERIFIED', profile: { create: { fullName: 'Lifecycle Admin' } } } }),
    ]);

    const vehicle = await prisma.vehicle.create({
      data: {
        ownerId: driver.id,
        assignedDriverId: driver.id,
        plateNumber: `TST-${suffix.toUpperCase()}`,
        type: 'Flatbed',
        capacityKg: 30_000,
        capacityM3: 55,
        documents: {
          create: ['REGISTRATION', 'INSURANCE', 'ROADWORTHINESS'].map((type) => ({
            type,
            title: type,
            state: 'VERIFIED' as const,
            expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          })),
        },
      },
    });
    await prisma.bankAccount.create({ data: { userId: driver.id, bankName: 'Lifecycle Test Bank', maskedNumber: '**** 0001', holderName: 'Lifecycle Driver', verified: true, payoutSchedule: 'Weekly' } });

    const shipment = await shipments.create(customer.id, {
      origin: 'Ikeja, Lagos',
      destination: 'Wuse, Abuja',
      originCoordinates: { latitude: 6.6018, longitude: 3.3515 },
      destinationCoordinates: { latitude: 9.0765, longitude: 7.3986 },
      cargoType: 'Packaged goods',
      quantity: '120 cartons',
      weightTons: 12,
      volumeM3: 30,
      truckType: 'Flatbed',
      pickupContactPhone: '+2348000000000',
    });
    expectValue(shipment.id, 'shipment was persisted');

    const initialized = await payments.initializeEscrow({ shipmentId: shipment.id, customerId: customer.id, customerEmail: customer.email });
    const webhookBody = {
      event: 'charge.success',
      data: {
        status: 'success',
        reference: initialized.providerReference,
        amount: initialized.amount,
        currency: initialized.currency,
        metadata: { shipmentId: shipment.id, purpose: 'shipment_escrow' },
      },
    };
    const rawWebhook = JSON.stringify(webhookBody);
    const signature = createHmac('sha512', 'sk_test_lifecycle_only').update(rawWebhook).digest('hex');
    const funded = await payments.recordWebhook('paystack', 'charge.success', webhookBody, signature, rawWebhook);
    expectValue(funded.verified && funded.escrowUpdated, 'signed payment webhook funded escrow');

    await shipments.approveShipment(shipment.id, adminUser.id, 'ADMIN');
    const assignment = await shipments.offerAssignment(shipment.id, { driverId: driver.id, vehicleId: vehicle.id }, dispatcher.role);
    await shipments.respondToAssignment(assignment.id, driver.id, 'ACCEPT');
    const driverActor = { sub: driver.id, role: driver.role, email: driver.email, verificationStatus: driver.verificationStatus };
    await tracking.recordLocation(shipment.id, driverActor, { latitude: 6.6018, longitude: 3.3515, note: 'Pickup confirmed.' });
    await shipments.addTimelineEvent(shipment.id, driver.id, 'DRIVER', { status: 'ARRIVED_PICKUP', note: 'Driver arrived at pickup.' });
    await shipments.addTimelineEvent(shipment.id, driver.id, 'DRIVER', { status: 'PICKED_UP', note: 'Cargo collected.' });
    await shipments.addTimelineEvent(shipment.id, driver.id, 'DRIVER', { status: 'IN_TRANSIT', note: 'Shipment in transit.' });
    await shipments.addTimelineEvent(shipment.id, driver.id, 'DRIVER', { status: 'ARRIVED_DESTINATION', note: 'Driver arrived at destination.' });
    const proof = await tracking.submitDeliveryProof(shipment.id, driverActor, { photoUrl: 'https://test.invalid/pod.jpg', recipientName: 'Lifecycle Receiver', note: 'Delivered intact.' });
    expectValue(proof.id, 'proof of delivery was persisted');

    await shipments.confirmEscrowCheck(shipment.id, 'arrivalConfirmed', 'DRIVER');
    await shipments.confirmEscrowCheck(shipment.id, 'customerDeliveryConfirmed', 'CUSTOMER');
    await shipments.confirmEscrowCheck(shipment.id, 'disputeWindowClear', 'CUSTOMER');
    const ready = await shipments.confirmEscrowCheck(shipment.id, 'platformApproved', 'ADMIN');
    expectValue(ready.status === 'RELEASE_READY', 'escrow reached release-ready state');
    const released = await shipments.releaseEscrow(shipment.id, 'ADMIN', 'Lifecycle test release.');
    expectValue(released.status === 'RELEASED', 'escrow was released');

    const earnings = await settings.driverEarnings(driver.id, { strict: true });
    expectValue(earnings.availableBalance === initialized.amount, 'released escrow appeared in driver earnings');
    const withdrawalAmount = Math.max(100, Math.floor(initialized.amount / 2));
    const withdrawal = await settings.requestDriverWithdrawal(driver.id, { amountKobo: withdrawalAmount, note: 'Lifecycle test withdrawal.' });
    expectValue(withdrawal.status === 'PENDING', 'driver withdrawal entered finance queue');
    const approved = await settings.reviewPayoutRequest(withdrawal.id, adminUser.id, { decision: 'APPROVED', note: 'Lifecycle finance approval.' });
    expectValue(approved.status === 'APPROVED', 'admin approved payout');
    const paid = await settings.reviewPayoutRequest(withdrawal.id, adminUser.id, { decision: 'PAID', note: 'Lifecycle payout settled.' });
    expectValue(paid.status === 'PAID', 'admin marked payout paid');

    const persisted = await prisma.shipment.findUnique({ where: { id: shipment.id }, include: { escrow: true, assignments: true, deliveryProofs: true } });
    const payout = await prisma.payout.findUnique({ where: { id: withdrawal.id } });
    expectValue(persisted?.status === 'COMPLETED', 'shipment completed in the database');
    expectValue(persisted.escrow?.status === 'RELEASED', 'released escrow persisted');
    expectValue(persisted.assignments[0]?.status === 'ACCEPTED', 'accepted assignment persisted');
    expectValue(persisted.deliveryProofs.length === 1, 'one proof of delivery persisted');
    expectValue(payout?.status === 'PAID', 'paid payout persisted');

    console.log('OK customer and verified driver created');
    console.log('OK shipment created and signed webhook funded escrow');
    console.log('OK admin approval, assignment, acceptance, pickup and delivery proof');
    console.log('OK escrow release, driver earnings, withdrawal approval and payout');
    console.log('DONE Tracko temporary-database lifecycle passed');
  } finally {
    await prisma?.onModuleDestroy();
    await admin.$executeRawUnsafe(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
    await admin.$disconnect();
  }
}

main().catch((error) => {
  console.error('FAILED Tracko temporary-database lifecycle');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
