import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShipmentEscalationsService } from './shipment-escalations.service';

const REASON = 'Pickup contact unreachable for two hours';
const row = (over: Record<string, unknown> = {}) => ({
  id: 'esc-1', shipmentId: 'ship-1', shipmentReference: 'TRK-1', route: 'Ikeja to Ibadan',
  raisedById: 'disp-1', raisedByRole: 'DISPATCHER', raisedByName: 'Tunde Dispatch', reason: REASON,
  status: 'OPEN', resolutionNote: null, resolvedByName: null, resolvedAt: null, createdAt: new Date(), ...over,
});
const uniqueViolation = () => new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23505`', {
  code: 'P2010', clientVersion: 'test', meta: { code: '23505' },
});

describe('ShipmentEscalationsService', () => {
  const dispatcher = { sub: 'disp-1', role: UserRole.DISPATCHER };
  const admin = { sub: 'admin-1', role: UserRole.ADMIN };
  let prisma: { shipment: { findFirst: jest.Mock }; $queryRawUnsafe: jest.Mock; $executeRawUnsafe: jest.Mock; escrow?: unknown };
  let notifications: { create: jest.Mock };
  let service: ShipmentEscalationsService;

  beforeEach(() => {
    prisma = {
      shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'ship-1', reference: 'TRK-1' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([row()]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    service = new ShipmentEscalationsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  });

  it.each([UserRole.CUSTOMER, UserRole.DRIVER, UserRole.TRUCK_OWNER])('refuses %s everywhere before touching data', async (role) => {
    const actor = { sub: 'x', role };
    await expect(service.raise('TRK-1', REASON, actor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listForShipment('TRK-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.queue('OPEN', actor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.resolve('esc-1', 'Called the customer, rebooked', actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipment.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('lets a dispatcher escalate by TRK reference and tells every admin', async () => {
    const result = await service.raise('TRK-1', `  ${REASON}  `, dispatcher);
    expect(prisma.shipment.findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: 'TRK-1' }, { reference: 'TRK-1' }] }, select: { id: true, reference: true } });
    const [sql, , shipmentId, raisedBy, role, reason] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('insert into "ShipmentEscalation"');
    expect([shipmentId, raisedBy, role, reason]).toEqual(['ship-1', 'disp-1', 'DISPATCHER', REASON]);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'ADMIN', title: 'Shipment TRK-1 escalated', body: REASON, tone: 'WARNING', actionUrl: '/admin/shipment/TRK-1' }));
    expect(result.status).toBe('OPEN');
  });

  it.each([undefined, null, 42, '', 'too short', '   short   ', 'x'.repeat(2001)])('refuses the reason %p', async (reason) => {
    await expect(service.raise('TRK-1', reason, dispatcher)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown shipment', async () => {
    prisma.shipment.findFirst.mockResolvedValue(null);
    await expect(service.raise('TRK-404', REASON, dispatcher)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a second open escalation on the same shipment without notifying admins again', async () => {
    prisma.$executeRawUnsafe.mockRejectedValue(uniqueViolation());
    await expect(service.raise('TRK-1', REASON, dispatcher)).rejects.toBeInstanceOf(ConflictException);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('still saves the escalation when the admin notification fails', async () => {
    notifications.create.mockRejectedValue(new Error('push down'));
    await expect(service.raise('TRK-1', REASON, dispatcher)).resolves.toMatchObject({ id: 'esc-1' });
  });

  it('lists the open queue oldest first and resolved newest first', async () => {
    await service.queue(undefined, admin);
    await service.queue('RESOLVED', dispatcher);
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain('order by e."createdAt" asc');
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toBe('OPEN');
    expect(prisma.$queryRawUnsafe.mock.calls[1][0]).toContain('order by e."createdAt" desc');
    expect(prisma.$queryRawUnsafe.mock.calls[1][1]).toBe('RESOLVED');
  });

  it('only an admin resolves, with a note, and the dispatcher who raised it is told', async () => {
    await expect(service.resolve('esc-1', 'Called the customer, rebooked', dispatcher)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.resolve('esc-1', 'ok', admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();

    prisma.$queryRawUnsafe.mockResolvedValue([row({ status: 'RESOLVED', resolutionNote: 'Called the customer, rebooked' })]);
    await service.resolve('esc-1', 'Called the customer, rebooked', admin);
    const [sql, id, note, resolvedBy] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain(`where "id" = $1 and "status" = 'OPEN'`);
    expect([id, note, resolvedBy]).toEqual(['esc-1', 'Called the customer, rebooked', 'admin-1']);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'disp-1', title: 'Escalation on TRK-1 resolved', actionUrl: '/dispatcher/shipment/TRK-1' }));
  });

  it('refuses to resolve twice and says when the escalation does not exist', async () => {
    prisma.$executeRawUnsafe.mockResolvedValue(0);
    await expect(service.resolve('esc-1', 'Called the customer, rebooked', admin)).rejects.toBeInstanceOf(ConflictException);
    prisma.$queryRawUnsafe.mockResolvedValue([]);
    await expect(service.resolve('esc-404', 'Called the customer, rebooked', admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never touches shipment, escrow or dispute state', async () => {
    await service.raise('TRK-1', REASON, dispatcher);
    await service.resolve('esc-1', 'Called the customer, rebooked', admin);
    const sql = [...prisma.$executeRawUnsafe.mock.calls, ...prisma.$queryRawUnsafe.mock.calls].map((call) => String(call[0]));
    expect(sql.filter((statement) => /^\s*(insert|update|delete)/i.test(statement)).every((statement) => statement.includes('"ShipmentEscalation"'))).toBe(true);
  });
});
