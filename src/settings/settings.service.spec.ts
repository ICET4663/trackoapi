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
