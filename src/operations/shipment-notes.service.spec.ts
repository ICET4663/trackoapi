import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ShipmentNotesService } from './shipment-notes.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ShipmentNotesService', () => {
  const admin = { sub: 'admin-1', role: UserRole.ADMIN };
  let prisma: { shipment: { findFirst: jest.Mock }; $queryRawUnsafe: jest.Mock };
  let service: ShipmentNotesService;
  beforeEach(() => {
    prisma = { shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'shipment-1' }) }, $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    service = new ShipmentNotesService(prisma as unknown as PrismaService);
  });

  it.each([UserRole.CUSTOMER, UserRole.DRIVER, UserRole.TRUCK_OWNER])('refuses %s before touching private data', async (role) => {
    const actor = { sub: 'other', role };
    await expect(service.list('shipment-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.append('shipment-1', 'Private note', actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.shipment.findFirst).not.toHaveBeenCalled();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([UserRole.ADMIN, UserRole.DISPATCHER])('lets %s read bounded shipment-specific notes', async (role) => {
    await service.list('shipment-1', { sub: 'staff', role });
    const [sql, shipment] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('LIMIT 200');
    expect(sql).toContain('ORDER BY "createdAt" DESC, "id" DESC');
    expect(shipment).toBe('shipment-1');
  });

  it('finds the shipment by its TRK reference, as the apps send it, and stores the internal id', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'note-1' }]);
    await service.append('TRK-1', 'Driver called about the gate', admin);
    expect(prisma.shipment.findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: 'TRK-1' }, { reference: 'TRK-1' }] }, select: { id: true } });
    expect(prisma.$queryRawUnsafe.mock.calls[0][2]).toBe('shipment-1');
  });

  it('refuses unknown shipments', async () => {
    prisma.shipment.findFirst.mockResolvedValue(null);
    await expect(service.append('missing', 'Note', admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 12, '', '   ', 'x'.repeat(4001)])('rejects an invalid note', async (body) => {
    await expect(service.append('shipment-1', body, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps content parameterized and records the authenticated author', async () => {
    const body = "Customer says 'hold'; DROP TABLE test;";
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'note-1', body }]);
    await expect(service.append('shipment-1', ` ${body} `, admin)).resolves.toMatchObject({ id: 'note-1', body });
    const [sql, id, shipment, author, role, content] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain(body);
    expect(id).toBeTruthy();
    expect([shipment, author, role, content]).toEqual(['shipment-1', 'admin-1', 'ADMIN', body]);
  });

  it('does not report success when insert returns no record', async () => {
    await expect(service.append('shipment-1', 'Note', admin)).rejects.toThrow('not saved');
  });
});

