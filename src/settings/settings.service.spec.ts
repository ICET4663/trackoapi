import { InternalServerErrorException } from '@nestjs/common';
import { SettingsService } from './settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';

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
    service = new SettingsService(prisma, notifications, config);
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
    service = new SettingsService(prisma, notifications, config);
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
