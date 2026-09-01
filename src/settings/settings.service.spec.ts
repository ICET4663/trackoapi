import { BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';
import type { AuthService } from '../auth/auth.service';

const noopAuthService = {} as unknown as AuthService;

describe('SettingsService driver availability', () => {
  it('persists whether a driver accepts new shipment offers', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{
      availableForAssignments: true,
      shareLiveTripLocation: true,
      nightDrivingCheckIns: true,
      emergencyContact: null,
    }]);
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const prisma = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      {} as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );

    const result = await service.updateSafetySetting(
      { key: 'availableForAssignments', value: false },
      'driver-1',
    );

    expect(result.availableForAssignments).toBe(false);
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"availableForAssignments"'),
      expect.any(String),
      'driver-1',
      false,
      true,
      true,
      null,
    );
  });

  it('validates and stores a driver foreground location', async () => {
    const locationUpdatedAt = new Date();
    const queryRawUnsafe = jest.fn().mockResolvedValue([{
      availableForAssignments: true,
      lastKnownLatitude: 6.5244,
      lastKnownLongitude: 3.3792,
      locationUpdatedAt,
    }]);
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      {} as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );

    const result = await service.updateDriverAvailabilityLocation('driver-1', {
      latitude: 6.5244,
      longitude: 3.3792,
    });

    expect(result).toMatchObject({ lastKnownLatitude: 6.5244, lastKnownLongitude: 3.3792 });
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"locationUpdatedAt"'),
      expect.any(String),
      'driver-1',
      6.5244,
      3.3792,
    );
  });

  it('rejects invalid driver coordinates before writing', async () => {
    const queryRawUnsafe = jest.fn();
    const service = new SettingsService(
      { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService,
      {} as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );

    await expect(service.updateDriverAvailabilityLocation('driver-1', {
      latitude: 200,
      longitude: 3.3792,
    })).rejects.toThrow('valid latitude');
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

// sendEmergencyAlert()/reportSafetyIncident() both go through createSafetyTicket(), whose
// catch block used to swallow ANY failure - a broken DB connection, a failed insert,
// anything - into a fake { sent: true, reported: true } response. A driver or customer
// hitting the panic button believed operations had been alerted when nothing was ever
// persisted or sent. These tests pin down that a real failure now surfaces as a real
// failure, and that a genuine success still returns the honest confirmation.
describe('SettingsService safety alerts never fake success on failure', () => {
  let executeRawUnsafe: jest.Mock;
  let auditLogCreate: jest.Mock;
  let notificationsCreate: jest.Mock;
  let service: SettingsService;

  beforeEach(() => {
    executeRawUnsafe = jest.fn().mockResolvedValue(1);
    auditLogCreate = jest.fn().mockResolvedValue(undefined);
    notificationsCreate = jest.fn().mockResolvedValue({ id: 'notif-1' });
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      auditLog: { create: auditLogCreate },
    } as unknown as PrismaService;
    const notifications = { create: notificationsCreate } as unknown as NotificationsService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    service = new SettingsService(prisma, notifications, config, noopAuthService);
  });

  it('throws a real error instead of a fake success when the SupportTicket insert fails', async () => {
    executeRawUnsafe.mockRejectedValue(new Error('connection reset'));

    await expect(service.sendEmergencyAlert('driver-1', 'DRIVER', {})).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    // Nothing downstream should have been attempted once the ticket itself failed to persist.
    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('returns an honest sent/reported confirmation when the ticket is actually persisted', async () => {
    const result = await service.reportSafetyIncident('driver-1', { message: 'Truck broke down' });

    expect(result).toMatchObject({ sent: true, reported: true, status: 'OPEN', priority: 'HIGH' });
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    // Admin, dispatcher, and the reporting user themselves are all notified.
    expect(notificationsCreate).toHaveBeenCalledTimes(3);
  });

  it('the ticket itself is already safely persisted even if a notification promise somehow rejects afterwards', async () => {
    notificationsCreate.mockRejectedValueOnce(new Error('push provider down'));

    await expect(service.sendEmergencyAlert('cust-1', 'CUSTOMER', {})).rejects.toThrow('push provider down');
    // In practice NotificationsService.create() catches its own errors and never rejects -
    // this only simulates the hypothetical case. Either way, staff can still find the
    // ticket in the support queue because the insert already committed before this ran.
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

// driverEarnings() falls back to a fixed preview balance (₦512,400) if its real balance
// computation fails, for the read-only earnings screen. requestDriverWithdrawal() must
// never validate a real withdrawal amount against that fake number - previously it did,
// via the same driverEarnings() call, meaning a DB hiccup could let a withdrawal request
// through that had nothing to do with the driver's actual released escrow.
describe('SettingsService.requestDriverWithdrawal never validates against the fake preview balance', () => {
  let queryRawUnsafe: jest.Mock;
  let payoutFindMany: jest.Mock;
  let payoutCreate: jest.Mock;
  let service: SettingsService;

  beforeEach(() => {
    queryRawUnsafe = jest.fn();
    payoutFindMany = jest.fn().mockResolvedValue([]);
    payoutCreate = jest.fn().mockResolvedValue({ id: 'payout-1', status: 'PENDING' });
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      payout: { findMany: payoutFindMany, create: payoutCreate },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue({ id: 'notif-1' }) } as unknown as NotificationsService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    service = new SettingsService(prisma, notifications, config, noopAuthService);
  });

  it('throws instead of silently falling back to the fake balance when the real computation fails', async () => {
    queryRawUnsafe.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.requestDriverWithdrawal('driver-1', { amountKobo: 10_000_000 }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(payoutCreate).not.toHaveBeenCalled();
  });

  it('still allows a real withdrawal within the real (non-fake) available balance', async () => {
    queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('"BankAccount"')) {
        return Promise.resolve([{ id: 'bank-1', bankName: 'GTBank', maskedNumber: '**** 1234', holderName: 'A Driver', verified: true, payoutSchedule: 'Weekly', pendingPayout: 'N0' }]);
      }
      if (sql.includes('"User"')) {
        return Promise.resolve([{ verificationStatus: 'VERIFIED' }]);
      }
      if (sql.includes(`e."status" = 'RELEASED'`)) {
        return Promise.resolve([{ shipmentId: 'shp-1', reference: 'TRK-1', route: 'Lagos to Abuja', amount: 20_000_000, currency: 'NGN', status: 'RELEASED', updatedAt: new Date() }]);
      }
      return Promise.resolve([]);
    });

    const result = await service.requestDriverWithdrawal('driver-1', { amountKobo: 10_000_000 });

    expect(payoutCreate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('PENDING');
  });
});

// updatePlatformSetting() used to just echo `{ ...defaults, value: body.value }` straight
// back to the caller with no database write at all - toggling e.g. maintenance mode in the
// admin UI looked like it saved, but reverted to the hardcoded default on the next load.
describe('SettingsService platform settings are actually persisted', () => {
  let findMany: jest.Mock;
  let findUnique: jest.Mock;
  let upsert: jest.Mock;
  let auditLogCreate: jest.Mock;
  let service: SettingsService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    findUnique = jest.fn().mockResolvedValue(null);
    upsert = jest.fn().mockResolvedValue({ key: 'maintenanceMode', value: 'true' });
    auditLogCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      platformSetting: { findMany, findUnique, upsert },
      auditLog: { create: auditLogCreate },
    } as unknown as PrismaService;
    const notifications = {} as unknown as NotificationsService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    service = new SettingsService(prisma, notifications, config, noopAuthService);
  });

  it('falls back to catalog defaults for settings that have never been changed', async () => {
    const settings = await service.platformSettings();

    const maintenance = settings.find((entry) => entry.key === 'maintenanceMode');
    expect(maintenance).toMatchObject({ value: 'false', displayValue: 'Off' });
  });

  it('reflects a real stored override instead of the default', async () => {
    findMany.mockResolvedValue([{ key: 'maintenanceMode', value: 'true' }]);

    const settings = await service.platformSettings();

    const maintenance = settings.find((entry) => entry.key === 'maintenanceMode');
    expect(maintenance).toMatchObject({ value: 'true', displayValue: 'On' });
  });

  it('actually upserts a real row and audit-logs the change, keyed to the acting admin', async () => {
    const result = await service.updatePlatformSetting('maintenanceMode', 'true', 'admin-1');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'maintenanceMode' },
      update: { value: 'true', updatedById: 'admin-1' },
      create: { key: 'maintenanceMode', value: 'true', updatedById: 'admin-1' },
    }));
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'admin-1', action: 'PLATFORM_SETTING_UPDATED' }),
    }));
    expect(result).toMatchObject({ key: 'maintenanceMode', value: 'true', displayValue: 'On' });
  });

  it('rejects an unknown setting key rather than silently creating one', async () => {
    await expect(service.updatePlatformSetting('notARealSetting', 'x', 'admin-1')).rejects.toThrow(
      'Unknown platform setting',
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean value for a boolean setting', async () => {
    await expect(service.updatePlatformSetting('maintenanceMode', 'yes', 'admin-1')).rejects.toThrow(
      'must be true or false',
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a pricing adjustment outside its safe range', async () => {
    await expect(service.updatePlatformSetting('pricingDemandSurgePercent', '75', 'admin-1')).rejects.toThrow(
      'must not exceed 50',
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('persists a valid pricing adjustment', async () => {
    const result = await service.updatePlatformSetting('pricingFuelSurchargePercent', '12.5', 'admin-1');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'pricingFuelSurchargePercent' },
      update: { value: '12.5', updatedById: 'admin-1' },
    }));
    expect(result).toMatchObject({ key: 'pricingFuelSurchargePercent', value: '12.5' });
  });

  it('throws a real error instead of a fake success when the write fails', async () => {
    upsert.mockRejectedValue(new Error('connection reset'));

    await expect(service.updatePlatformSetting('maintenanceMode', 'true', 'admin-1')).rejects.toThrow(
      'Could not save',
    );
  });
});

describe('SettingsService pricing report uses accepted quote audit records', () => {
  it('summarizes quote value, weighted route rate, and live-route usage', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'audit-quote-1',
        entityId: 'shipment-1',
        createdAt: new Date('2026-08-20T10:00:00.000Z'),
        actor: { email: 'customer@tracko.ng', profile: { fullName: 'Tracko Customer' } },
        metadata: {
          quotedPriceKobo: 30_000_000,
          distanceKm: 300,
          provider: 'google',
          pricingMode: 'live_road_route',
          pricingVersion: '2026.08',
          pricingBreakdown: { truckType: 'Flatbed' },
        },
      },
      {
        id: 'audit-quote-2',
        entityId: 'shipment-2',
        createdAt: new Date('2026-08-19T10:00:00.000Z'),
        actor: { email: 'second@tracko.ng', profile: null },
        metadata: {
          quotedPriceKobo: 10_000_000,
          distanceKm: 100,
          provider: 'coordinate',
          pricingMode: 'coordinate_estimate',
          pricingVersion: '2026.08',
          pricingBreakdown: { truckType: 'Box truck' },
        },
      },
    ]);
    const prisma = { auditLog: { findMany } } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      {} as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );

    const report = await service.pricingReport();

    expect(report).toMatchObject({
      acceptedQuoteCount: 2,
      totalQuoteValueKobo: 40_000_000,
      averageQuoteKobo: 20_000_000,
      averageRatePerKmKobo: 100_000,
      liveRoutePercent: 50,
    });
    expect(report.latestQuotes[0]).toMatchObject({
      shipmentId: 'shipment-1',
      customer: 'Tracko Customer',
      truckType: 'Flatbed',
    });
  });
});

// Driver documents (license, insurance, etc.) previously landed on a hardcoded state
// regardless of upload, and nothing anywhere ever set one to VERIFIED - there was no real
// review workflow at all, unlike KYC which already had one. These pin down the real
// upload-then-review lifecycle: uploadDriverDocument() throws instead of faking success on
// a write failure, and reviewDriverDocument() actually transitions PENDING_REVIEW ->
// VERIFIED/REJECTED with a real, race-safe conditional update.
describe('SettingsService driver document review is a real workflow, not a fake state', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const auditLogCreate = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      auditLog: { create: auditLogCreate },
    } as unknown as PrismaService;
    const notificationsCreate = jest.fn().mockResolvedValue({ id: 'notif-1' });
    const notifications = { create: notificationsCreate } as unknown as NotificationsService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    const service = new SettingsService(prisma, notifications, config, noopAuthService);
    return { service, auditLogCreate, notificationsCreate };
  }

  it('uploadDriverDocument throws a real error instead of a fake success when the write fails', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service } = buildService(queryRawUnsafe);

    await expect(
      service.uploadDriverDocument('driver-1', 'license', { fileUrl: 'https://example.com/license.jpg' }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('a genuinely successful upload lands the document on PENDING_REVIEW, not a fake verified/expiring state', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([
      { id: 'license', title: 'License', meta: 'Uploaded - pending review', state: 'pending_review', fileUrl: 'https://example.com/license.jpg' },
    ]);
    const { service } = buildService(queryRawUnsafe);

    const result = await service.uploadDriverDocument('driver-1', 'license', { fileUrl: 'https://example.com/license.jpg' });

    expect(result.document.state).toBe('pending_review');
  });

  it('reviewDriverDocument approves a pending document to VERIFIED and notifies the driver', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([
      { id: 'doc-1', userId: 'driver-1', title: 'License', state: 'verified' },
    ]);
    const { service, auditLogCreate, notificationsCreate } = buildService(queryRawUnsafe);

    const result = await service.reviewDriverDocument('doc-1', 'admin-1', { decision: 'APPROVE' });

    expect(result).toMatchObject({ id: 'doc-1', state: 'verified', decision: 'APPROVE' });
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorId: 'admin-1', action: 'DRIVER_DOCUMENT_APPROVED' }),
    }));
    expect(notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'driver-1', tone: 'SUCCESS' }));
  });

  it('reviewDriverDocument rejects a pending document with a note and notifies the driver why', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([
      { id: 'doc-1', userId: 'driver-1', title: 'License', state: 'rejected' },
    ]);
    const { service, notificationsCreate } = buildService(queryRawUnsafe);

    await service.reviewDriverDocument('doc-1', 'admin-1', { decision: 'REJECT', note: 'Photo is blurry' });

    expect(notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'driver-1',
      tone: 'DANGER',
      body: expect.stringContaining('Photo is blurry'),
    }));
  });

  it('rejects reviewing a document that is not actually pending (already reviewed, or race-lost)', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const { service } = buildService(queryRawUnsafe);

    await expect(service.reviewDriverDocument('doc-1', 'admin-1', { decision: 'APPROVE' })).rejects.toThrow(
      'already been reviewed',
    );
  });

  it('rejects an invalid decision value', async () => {
    const { service } = buildService(jest.fn());

    await expect(service.reviewDriverDocument('doc-1', 'admin-1', { decision: 'MAYBE' })).rejects.toThrow(
      'APPROVE or REJECT',
    );
  });
});

describe('SettingsService vehicle document review', () => {
  function buildService(options?: { vehicle?: { id: string; plateNumber: string } | null; rows?: unknown[] }) {
    const queryRawUnsafe = jest.fn().mockResolvedValue(options?.rows ?? []);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      vehicle: { findFirst: jest.fn().mockResolvedValue(options && 'vehicle' in options ? options.vehicle : { id: 'vehicle-1', plateNumber: 'LAG-123-AA' }) },
    } as unknown as PrismaService;
    const notificationsCreate = jest.fn().mockResolvedValue({ id: 'notice-1' });
    const service = new SettingsService(
      prisma,
      { create: notificationsCreate } as unknown as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );
    return { service, queryRawUnsafe, notificationsCreate };
  }

  it('does not let one owner inspect another owner\'s truck documents', async () => {
    const { service } = buildService({ vehicle: null });

    await expect(service.vehicleDocuments('vehicle-1', 'owner-2')).rejects.toThrow('Truck not found');
  });

  it('uploads a supported document into pending review and alerts operations', async () => {
    const { service, queryRawUnsafe, notificationsCreate } = buildService({ rows: [{ id: 'doc-1', state: 'pending_review' }] });

    const result = await service.uploadVehicleDocument('vehicle-1', 'owner-1', 'insurance', { fileUrl: 'https://example.com/insurance.jpg' });

    expect(result).toMatchObject({ uploaded: true, document: { state: 'pending_review' } });
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('PENDING_REVIEW'), expect.any(String), 'vehicle-1', 'INSURANCE', expect.any(String), null, null, 'https://example.com/insurance.jpg');
    expect(notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN', entity: 'VehicleDocument' }));
  });

  it('requires an actionable reviewer note when rejecting a vehicle document', async () => {
    const { service } = buildService();

    await expect(service.reviewVehicleDocument('doc-1', 'admin-1', { decision: 'REJECT' })).rejects.toThrow('reviewer note');
  });

  it('approves only a pending document and notifies its owner', async () => {
    const { service, notificationsCreate } = buildService({ rows: [{ id: 'doc-1', vehicleId: 'vehicle-1', title: 'Insurance certificate', ownerId: 'owner-1', plateNumber: 'LAG-123-AA', state: 'verified' }] });

    const result = await service.reviewVehicleDocument('doc-1', 'admin-1', { decision: 'APPROVE' });

    expect(result).toMatchObject({ id: 'doc-1', state: 'verified', decision: 'APPROVE' });
    expect(notificationsCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', tone: 'SUCCESS' }));
  });
});

describe('SettingsService.billingHistory is real per-account/per-card data, not fabricated invoices', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      {} as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );
    return { service };
  }

  it('returns an honest empty list - not the old hardcoded fake invoices - when the user genuinely has no charges', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const { service } = buildService(queryRawUnsafe);

    const result = await service.billingHistory('customer-1');

    expect(result).toEqual([]);
  });

  it('returns an honest empty list, not fake invoices, when the query itself fails', async () => {
    const queryRawUnsafe = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service } = buildService(queryRawUnsafe);

    const result = await service.billingHistory('customer-1');

    expect(result).toEqual([]);
  });

  it('filters by paymentMethodId when viewing one card\'s billing history, instead of returning every card\'s charges', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([{ id: 'bill-1', ref: 'TRK-1', date: 'Jan 1, 2026', amount: 'N1,000' }]);
    const { service } = buildService(queryRawUnsafe);

    await service.billingHistory('customer-1', 'card-1');

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"paymentMethodId" = $2'),
      'customer-1',
      'card-1',
    );
  });

  it('does not filter by paymentMethodId when none is given', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const { service } = buildService(queryRawUnsafe);

    await service.billingHistory('customer-1');

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.not.stringContaining('paymentMethodId'),
      'customer-1',
    );
  });
});

describe('SettingsService.updatePreferredLanguage', () => {
  function buildService(userUpdate: jest.Mock) {
    const prisma = { user: { update: userUpdate } } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);
    return { service };
  }

  it('rejects an unsupported language code', async () => {
    const { service } = buildService(jest.fn());

    await expect(service.updatePreferredLanguage('user-1', 'fr')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing language', async () => {
    const { service } = buildService(jest.fn());

    await expect(service.updatePreferredLanguage('user-1', undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws a real error instead of a silent no-op when the write fails', async () => {
    const { service } = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.updatePreferredLanguage('user-1', 'yo')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('saves a supported language on success', async () => {
    const userUpdate = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService(userUpdate);

    const result = await service.updatePreferredLanguage('user-1', 'yo');

    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { preferredLanguage: 'yo' } });
    expect(result).toEqual({ preferredLanguage: 'yo' });
  });
});

// profile()/updateProfile() used to fall back to a fake identity - hardcoded name
// "Tracko Preview User", email customer@tracko.ng, phone +234 800 000 0000, and a fake
// "VERIFIED" status belonging to nobody - on any DB read failure or a genuinely-missing
// user row. A real authenticated user could see someone else's fake identity on their
// own Personal Details screen.
describe('SettingsService.profile never fakes a user\'s own identity', () => {
  function buildService(userFindUnique: jest.Mock) {
    const prisma = { user: { findUnique: userFindUnique } } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);
    return { service };
  }

  it('throws a real error instead of a fake identity when the read fails', async () => {
    const { service } = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.profile('user-1')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('throws NotFoundException instead of a fake identity when the user row is missing', async () => {
    const { service } = buildService(jest.fn().mockResolvedValue(null));

    await expect(service.profile('user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the real profile on success', async () => {
    const { service } = buildService(jest.fn().mockResolvedValue({
      id: 'user-1', email: 'real@user.com', phone: '+2348000000001', role: 'CUSTOMER', verificationStatus: 'PENDING',
      profile: { fullName: 'Real Name', address: null, city: null, state: null, avatarUrl: null },
    }));

    const result = await service.profile('user-1');

    expect(result).toMatchObject({ fullName: 'Real Name', email: 'real@user.com', verificationStatus: 'PENDING' });
  });
});

// This was a genuinely serious bug, not just fake preview data: the DriverDocument
// primary key used to be the bare type slug ("license"/"insurance") with no per-user
// scoping, so two different drivers uploading the same document type collided on the
// same row via `on conflict ("id")` - the second upload silently overwrote the first
// driver's file/review state while the row stayed attributed to the FIRST driver.
describe('SettingsService driver document uploads are correctly scoped per driver', () => {
  it('computes a per-user database id, never the bare type slug, for the upload', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue(undefined);
    const prisma = { $queryRawUnsafe: queryRawUnsafe, auditLog: { create: jest.fn().mockResolvedValue(undefined) } } as unknown as PrismaService;
    const service = new SettingsService(
      prisma,
      { create: jest.fn().mockResolvedValue({ id: 'n1' }) } as unknown as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );

    await service.uploadDriverDocument('driver-A', 'license', { fileUrl: 'https://example.com/a.jpg' });
    await service.uploadDriverDocument('driver-B', 'license', { fileUrl: 'https://example.com/b.jpg' });

    const idsUsed = queryRawUnsafe.mock.calls.map((call) => call[1]);
    expect(idsUsed).toEqual(['driver-A_license', 'driver-B_license']);
    expect(idsUsed[0]).not.toBe(idsUsed[1]);
  });

  it('driverDocuments() returns an honest "missing" row per required type, not fake verified data, before any upload', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);

    const result = await service.driverDocuments('driver-A');

    expect(result).toEqual([
      { id: 'license', title: 'Driver license', meta: 'Upload required', state: 'missing' },
      { id: 'insurance', title: 'Insurance certificate', meta: 'Upload required', state: 'missing' },
    ]);
  });

  it('driverDocuments() maps a real row back to its bare type slug, scoped to the correct driver only', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([
      { id: 'driver-A_license', title: 'License', meta: 'Uploaded - pending review', state: 'pending_review', fileUrl: 'https://example.com/a.jpg' },
    ]);
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);

    const result = await service.driverDocuments('driver-A');

    expect(result[0]).toMatchObject({ id: 'license', state: 'pending_review', fileUrl: 'https://example.com/a.jpg' });
    expect(result[1]).toMatchObject({ id: 'insurance', state: 'missing' });
  });
});

describe('SettingsService saved addresses never fake success', () => {
  function buildService(queryRawUnsafe: jest.Mock) {
    const prisma = { $queryRawUnsafe: queryRawUnsafe } as unknown as PrismaService;
    const service = new SettingsService(prisma, {} as NotificationsService, { get: jest.fn() } as unknown as ConfigService, noopAuthService);
    return { service };
  }

  it('savedAddresses() throws instead of 2 fake hardcoded addresses on a read failure', async () => {
    const { service } = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.savedAddresses('customer-1')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('saveAddress() throws instead of echoing back the submitted input as "saved" when the insert fails', async () => {
    const { service } = buildService(jest.fn().mockRejectedValue(new Error('connection reset')));

    await expect(service.saveAddress({ label: 'Home', city: 'Lagos' }, undefined, 'customer-1'))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('saveAddress() returns the real saved row on success', async () => {
    const { service } = buildService(jest.fn().mockResolvedValue([
      { id: 'addr-1', label: 'Home', line: 'Lekki', city: 'Lagos', address: null, icon: null, isDefaultPickup: false },
    ]));

    const result = await service.saveAddress({ label: 'Home', city: 'Lagos' }, undefined, 'customer-1');

    expect(result).toMatchObject({ id: 'addr-1', label: 'Home' });
  });
});

// adminPayoutRequests()/reviewPayoutRequest() used to fall back to a single fabricated
// "Tracko Driver, N120,000, Preview Bank **** 0012" pending withdrawal on any read
// failure, and reviewPayoutRequest() had a matching special case that let an admin
// "approve"/"mark paid" that fake id without ever touching the real Payout table - an
// admin could believe they'd paid a driver N120,000 when nothing happened on either side.
describe('SettingsService payout review never fakes a withdrawal request', () => {
  function buildPayoutService(prismaOverrides: Record<string, unknown>) {
    const prisma = {
      notification: { create: jest.fn() },
      ...prismaOverrides,
    } as unknown as PrismaService;
    return new SettingsService(
      prisma,
      { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );
  }

  it('adminPayoutRequests() throws instead of a fake pending withdrawal when the read fails', async () => {
    const service = buildPayoutService({
      payout: { findMany: jest.fn().mockRejectedValue(new Error('connection reset')) },
    });

    await expect(service.adminPayoutRequests()).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('adminPayoutRequests() returns the real (possibly empty) list on success', async () => {
    const service = buildPayoutService({
      payout: { findMany: jest.fn().mockResolvedValue([]) },
    });

    await expect(service.adminPayoutRequests()).resolves.toEqual([]);
  });

  it('reviewPayoutRequest() throws NotFoundException for a fake "payout-preview-" id instead of faking a decision', async () => {
    const service = buildPayoutService({
      payout: { findUnique: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.reviewPayoutRequest('payout-preview-1', 'admin-1', { decision: 'PAID' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('reviewPayoutRequest() records a real decision against a real payout row', async () => {
    const update = jest.fn().mockResolvedValue({
      id: 'payout-1', driverId: 'driver-1', amountKobo: 5_000_00, status: 'PAID',
    });
    const service = buildPayoutService({
      payout: {
        findUnique: jest.fn().mockResolvedValue({ id: 'payout-1', driverId: 'driver-1' }),
        update,
      },
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
    });

    const result = await service.reviewPayoutRequest('payout-1', 'admin-1', { decision: 'PAID' });

    expect(result.id).toBe('payout-1');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'payout-1' } }));
  });
});

// accountOverview() is the very first screen every user sees after logging in - it used
// to catch ANY read failure and return hardcoded fake stats per role ("12 trips, 5.0
// rating", "3 trucks", "8 open, 1 alert, 24 resolved" for admin) instead of an error.
// notificationPreferences()/updateNotificationPreference()/paymentMethod()/
// supportTickets()/resolveSupportTicket()/auditLogs()/auditLog() had the same pattern
// across reads (silent defaults or fabricated records) and writes (echoing back the
// requested value, or a fake "resolved"/"saved" confirmation, as if it had persisted).
describe('SettingsService admin/dashboard/preference reads and writes never fake data', () => {
  function buildService(prismaOverrides: Record<string, unknown>) {
    const prisma = { ...prismaOverrides } as unknown as PrismaService;
    return new SettingsService(
      prisma,
      { unreadCount: jest.fn().mockResolvedValue({ unreadCount: 0 }), create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
      { get: jest.fn() } as unknown as ConfigService,
      noopAuthService,
    );
  }

  it('accountOverview() throws instead of fake dashboard stats when the read fails', async () => {
    const service = buildService({
      shipment: { count: jest.fn().mockRejectedValue(new Error('connection reset')) },
      $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')),
    });

    await expect(service.accountOverview('CUSTOMER', 'cust-1')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('notificationPreferences() throws instead of silent defaults when the read fails', async () => {
    const service = buildService({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.notificationPreferences('user-1')).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('updateNotificationPreference() throws instead of echoing back the requested value when the write fails', async () => {
    const service = buildService({ $executeRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.updateNotificationPreference('user-1', 'CUSTOMER', { key: 'smsAlerts' as never, value: false }))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('paymentMethod() throws NotFoundException instead of silently returning a different card under the wrong id', async () => {
    const service = buildService({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'pm-real', brand: 'Visa', maskedNumber: '**** 1111' }]),
    });

    await expect(service.paymentMethod('pm-does-not-exist', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('supportTickets() throws instead of a fake pending ticket when the read fails', async () => {
    const service = buildService({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.supportTickets()).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('resolveSupportTicket() throws instead of a fake "resolved" confirmation when the update fails', async () => {
    const service = buildService({ $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('connection reset')) });

    await expect(service.resolveSupportTicket('ticket-1', 'admin-1', {})).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('auditLogs() throws instead of fabricated audit history when the read fails', async () => {
    const service = buildService({ auditLog: { findMany: jest.fn().mockRejectedValue(new Error('connection reset')) } });

    await expect(service.auditLogs()).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('auditLog(id) throws NotFoundException for a real missing id instead of a fabricated entry under a different id', async () => {
    const service = buildService({ auditLog: { findUnique: jest.fn().mockResolvedValue(null) } });

    await expect(service.auditLog('audit-does-not-exist')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('auditLog(id) throws a real error instead of fabricated audit data on an actual read failure', async () => {
    const service = buildService({ auditLog: { findUnique: jest.fn().mockRejectedValue(new Error('connection reset')) } });

    await expect(service.auditLog('audit-1')).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
