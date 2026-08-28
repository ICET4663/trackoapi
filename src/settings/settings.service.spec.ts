import { InternalServerErrorException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';
import type { AuthService } from '../auth/auth.service';

const noopAuthService = {} as unknown as AuthService;

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
