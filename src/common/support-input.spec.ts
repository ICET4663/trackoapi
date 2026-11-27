import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import {
  accessibleShipmentId,
  MAX_INT_KOBO,
  safetyLocation,
  safetyMessage,
  shipmentRef,
  SUPPORT_MESSAGE_MAX,
  supportChannel,
  supportMessage,
  supportTopic,
  ticketId,
} from './support-input';

describe('support input rules', () => {
  it('accepts the three channels in any case and defaults to CHAT', () => {
    expect(supportChannel(undefined)).toBe('CHAT');
    expect(supportChannel(' email ')).toBe('EMAIL');
    expect(() => supportChannel('EMERGENCY')).toThrow(BadRequestException);
    expect(() => supportChannel({})).toThrow(BadRequestException);
  });

  it('refuses a support message over the limit and non-text messages', () => {
    expect(supportMessage('  hi  ')).toBe('hi');
    expect(supportMessage('   ')).toBeNull();
    expect(() => supportMessage('x'.repeat(SUPPORT_MESSAGE_MAX + 1))).toThrow(BadRequestException);
    expect(() => supportMessage({ text: 'hi' })).toThrow(BadRequestException);
  });

  it('cuts topics and safety messages instead of refusing them', () => {
    expect(supportTopic('x'.repeat(500), 'General').length).toBe(120);
    expect(supportTopic({}, 'General')).toBe('General');
    expect(safetyMessage('y'.repeat(9000), 'fallback').length).toBe(SUPPORT_MESSAGE_MAX);
    expect(safetyMessage(['odd'], 'fallback')).toBe('fallback');
  });

  it('keeps only real coordinates', () => {
    expect(safetyLocation(6.5, 3.3)).toEqual({ latitude: 6.5, longitude: 3.3 });
    expect(safetyLocation('6.5', '3.3')).toEqual({ latitude: 6.5, longitude: 3.3 });
    expect(safetyLocation(0, 0)).toEqual({ latitude: 0, longitude: 0 });
    expect(safetyLocation(95, 3)).toBeNull();
    expect(safetyLocation('abc', 3)).toBeNull();
    expect(safetyLocation(6.5, undefined)).toBeNull();
  });

  it('gives distinct ticket ids in the same millisecond', () => {
    const ids = new Set(Array.from({ length: 50 }, () => ticketId('support')));
    expect(ids.size).toBe(50);
  });

  it('reads a shipment reference as short text only', () => {
    expect(shipmentRef(' TRK-1 ')).toBe('TRK-1');
    expect(shipmentRef({ id: 'x' })).toBeNull();
    expect(shipmentRef('x'.repeat(65))).toBeNull();
  });

  describe('accessibleShipmentId', () => {
    const lookup = (shipment: { id: string; customerId: string } | null, assignment: { id: string } | null = null) => ({
      shipment: { findFirst: jest.fn().mockResolvedValue(shipment) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
    });

    it('allows the customer, staff and a linked driver or owner', async () => {
      const own = lookup({ id: 's1', customerId: 'c1' });
      await expect(accessibleShipmentId(own, 'c1', 'CUSTOMER', 'TRK-1')).resolves.toBe('s1');
      await expect(accessibleShipmentId(own, 'staff', 'DISPATCHER', 's1')).resolves.toBe('s1');
      const driver = lookup({ id: 's1', customerId: 'c1' }, { id: 'a1' });
      await expect(accessibleShipmentId(driver, 'd1', 'DRIVER', 's1')).resolves.toBe('s1');
    });

    it("refuses someone else's shipment and an unknown one", async () => {
      await expect(accessibleShipmentId(lookup({ id: 's1', customerId: 'c1' }), 'c2', 'CUSTOMER', 's1')).resolves.toBeNull();
      await expect(accessibleShipmentId(lookup(null), 'c1', 'CUSTOMER', 'nope')).resolves.toBeNull();
      await expect(accessibleShipmentId(lookup(null), 'c1', 'CUSTOMER', null)).resolves.toBeNull();
    });
  });
});

describe('SettingsService support and safety inputs', () => {
  let executeRawUnsafe: jest.Mock;
  let findShipment: jest.Mock;
  let service: SettingsService;

  beforeEach(() => {
    executeRawUnsafe = jest.fn().mockResolvedValue(1);
    findShipment = jest.fn().mockResolvedValue(null);
    const prisma = {
      $executeRawUnsafe: executeRawUnsafe,
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      auditLog: { create: jest.fn().mockResolvedValue(undefined) },
      shipment: { findFirst: findShipment },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue({ id: 'n1' }) } as unknown as NotificationsService;
    service = new SettingsService(prisma, notifications, { get: jest.fn() } as unknown as ConfigService, {} as AuthService);
  });

  afterEach(() => jest.restoreAllMocks());

  it("refuses a support request linked to a shipment that is not the user's", async () => {
    findShipment.mockResolvedValue({ id: 's1', customerId: 'someone-else' });
    await expect(service.createSupportContact('c1', { message: 'Help', shipmentId: 's1' }, 'CUSTOMER')).rejects.toThrow(BadRequestException);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('saves the real shipment id when the customer gives its TRK reference', async () => {
    findShipment.mockResolvedValue({ id: 's1', customerId: 'c1' });
    await service.createSupportContact('c1', { message: 'Help', shipmentId: 'TRK-1', channel: 'phone' }, 'CUSTOMER');
    const args = executeRawUnsafe.mock.calls[0];
    expect(args[2]).toBe('s1');
    expect(args[5]).toBe('PHONE');
  });

  it('keeps database error text out of the support error', async () => {
    executeRawUnsafe.mockRejectedValue(new Error('relation "SupportTicket" violates constraint xyz'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = await service.createSupportContact('c1', { message: 'Help' }, 'CUSTOMER').catch((e: Error) => e);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(String((error as Error).message)).not.toContain('constraint');
  });

  it('still sends a safety alert when its shipment link is unknown, dropping the link', async () => {
    const result = await service.sendEmergencyAlert('d1', 'DRIVER', { shipmentId: 'bogus', latitude: 999, longitude: 3, message: 'Help' });
    expect(result).toMatchObject({ sent: true });
    const args = executeRawUnsafe.mock.calls[0];
    expect(args[2]).toBeNull();
    expect(args[5]).toBe('Help');
  });

  it('refuses a truck expense too large for the ledger column', async () => {
    const internals = service as unknown as { assertVehicleOwner: () => Promise<unknown>; ensureVehicleExpenseLedger: () => Promise<void> };
    jest.spyOn(internals, 'assertVehicleOwner').mockResolvedValue({ id: 'v1' });
    jest.spyOn(internals, 'ensureVehicleExpenseLedger').mockResolvedValue(undefined);
    await expect(service.createVehicleExpense('v1', 'o1', { category: 'FUEL', amountKobo: MAX_INT_KOBO + 1 })).rejects.toThrow('too large');
  });
});
