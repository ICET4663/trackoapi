import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type StaffActor = { sub: string; role: UserRole };
type ShipmentNote = { id: string; shipmentId: string; authorId: string; authorRole: string; body: string; createdAt: Date };

@Injectable()
export class ShipmentNotesService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAccess(shipmentId: string, actor: StaffActor) {
    if (actor.role !== 'ADMIN' && actor.role !== 'DISPATCHER') {
      throw new ForbiddenException('Shipment notes are private to operations staff.');
    }
    // The apps address shipments by reference (TRK-...); accept the internal id too.
    const shipment = await this.prisma.shipment.findFirst({
      where: { OR: [{ id: shipmentId }, { reference: shipmentId }] },
      select: { id: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    return shipment.id;
  }

  async list(shipmentRef: string, actor: StaffActor) {
    const shipmentId = await this.assertAccess(shipmentRef, actor);
    return this.prisma.$queryRawUnsafe<ShipmentNote[]>(`
      SELECT "id", "shipmentId", "authorId", "authorRole", "body", "createdAt"
      FROM "ShipmentInternalNote" WHERE "shipmentId" = $1
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 200
    `, shipmentId);
  }

  async append(shipmentRef: string, body: unknown, actor: StaffActor) {
    const shipmentId = await this.assertAccess(shipmentRef, actor);
    if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 4000) {
      throw new BadRequestException('Write a note between 1 and 4,000 characters.');
    }
    const notes = await this.prisma.$queryRawUnsafe<ShipmentNote[]>(`
      INSERT INTO "ShipmentInternalNote" ("id", "shipmentId", "authorId", "authorRole", "body")
      VALUES ($1, $2, $3, $4, $5)
      RETURNING "id", "shipmentId", "authorId", "authorRole", "body", "createdAt"
    `, randomUUID(), shipmentId, actor.sub, actor.role, body.trim());
    if (!notes[0]) throw new Error('The shipment note was not saved.');
    return notes[0];
  }
}

