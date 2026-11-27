import { BadRequestException } from '@nestjs/common';
import { OperationsService } from './operations.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ShipmentsService } from '../shipments/shipments.service';

// 27 Nov: POST /v1/support/tickets and disputes get the same input rules as /v1/support/contact.

function build(prisma: Record<string, unknown>) {
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const service = new OperationsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    {} as ShipmentsService,
  );
  return { service, notifications };
}

const customer = { sub: 'cust-1', role: 'CUSTOMER' as const };

describe('support tickets (operations)', () => {
  it('saves only checked values and links only the user\'s own shipment', async () => {
    const queryRawUnsafe = jest.fn().mockResolvedValue([]);
    const { service } = build({
      $queryRawUnsafe: queryRawUnsafe,
      shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'ship-1', customerId: 'cust-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    });

    const result = await service.createSupportTicket({ channel: 'phone', topic: '  Late pickup ', message: ' Driver is late ', shipmentId: 'TRK-1' }, customer);

    const args = queryRawUnsafe.mock.calls[0];
    expect(args[1]).toMatch(/^SUP-\d+-[0-9a-f]{8}$/);
    expect(args.slice(2)).toEqual(['ship-1', 'cust-1', 'Late pickup', 'PHONE', 'Driver is late']);
    expect(result).toMatchObject({ status: 'OPEN', topic: 'Late pickup', channel: 'PHONE' });
  });

  it('refuses an unknown channel, an over-long message, and someone else\'s shipment before saving', async () => {
    const queryRawUnsafe = jest.fn();
    const { service } = build({
      $queryRawUnsafe: queryRawUnsafe,
      shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'ship-9', customerId: 'someone-else' }) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.createSupportTicket({ channel: 'FAX' }, customer)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSupportTicket({ message: 'x'.repeat(4001) }, customer)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createSupportTicket({ shipmentId: 'TRK-9' }, customer)).rejects.toThrow('That shipment was not found on your account.');
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('disputes', () => {
  it('refuses an unknown priority and an over-long description before any lookup', async () => {
    const findFirst = jest.fn();
    const { service } = build({ shipment: { findFirst } });

    await expect(service.createDispute({ priority: 'CRITICAL' }, customer)).rejects.toThrow('Priority must be one of: LOW, MEDIUM, HIGH.');
    await expect(service.createDispute({ description: 'x'.repeat(4001) }, customer)).rejects.toThrow('Description must be 4,000 characters or fewer.');
    await expect(service.createDispute({ reason: 'x'.repeat(201) }, customer)).rejects.toThrow('Reason must be 200 characters or fewer.');
    expect(findFirst).not.toHaveBeenCalled();
  });
});
