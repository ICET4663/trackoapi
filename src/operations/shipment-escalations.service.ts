import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type StaffActor = { sub: string; role: UserRole };
export type EscalationStatus = 'OPEN' | 'RESOLVED';
export type ShipmentEscalation = {
  id: string;
  shipmentId: string;
  shipmentReference: string;
  route: string;
  raisedById: string;
  raisedByRole: 'ADMIN' | 'DISPATCHER';
  raisedByName: string;
  reason: string;
  status: EscalationStatus;
  resolutionNote: string | null;
  resolvedByName: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

const TEXT_MIN = 10;
const TEXT_MAX = 2000;

const SELECT = `
  select e."id", e."shipmentId", s."reference" as "shipmentReference",
    s."pickupLabel" || ' to ' || s."destinationLabel" as "route",
    e."raisedById", e."raisedByRole", coalesce(rp."fullName", ru."email") as "raisedByName",
    e."reason", e."status", e."resolutionNote", coalesce(sp."fullName", su."email") as "resolvedByName",
    e."resolvedAt", e."createdAt"
  from "ShipmentEscalation" e
  join "Shipment" s on s."id" = e."shipmentId"
  join "User" ru on ru."id" = e."raisedById"
  left join "Profile" rp on rp."userId" = ru."id"
  left join "User" su on su."id" = e."resolvedById"
  left join "Profile" sp on sp."userId" = su."id"`;

// Operations staff flag a shipment for an admin, with a reason; an admin closes it with a
// resolution note. Informational only: nothing here touches trip, payment or dispute state.
@Injectable()
export class ShipmentEscalationsService {
  private readonly logger = new Logger(ShipmentEscalationsService.name);

  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  private assertStaff(actor: StaffActor) {
    if (actor.role !== 'ADMIN' && actor.role !== 'DISPATCHER') {
      throw new ForbiddenException('Escalations are for operations staff.');
    }
  }

  private text(value: unknown, what: string) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length < TEXT_MIN || trimmed.length > TEXT_MAX) {
      throw new BadRequestException(`Write a ${what} between ${TEXT_MIN} and ${TEXT_MAX.toLocaleString('en')} characters.`);
    }
    return trimmed;
  }

  private async findShipment(shipmentRef: string) {
    // The apps address shipments by reference (TRK-...); accept the internal id too.
    const shipment = await this.prisma.shipment.findFirst({
      where: { OR: [{ id: shipmentRef }, { reference: shipmentRef }] },
      select: { id: true, reference: true },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    return shipment;
  }

  private async byId(id: string) {
    const [row] = await this.prisma.$queryRawUnsafe<ShipmentEscalation[]>(`${SELECT} where e."id" = $1`, id);
    return row;
  }

  async listForShipment(shipmentRef: string, actor: StaffActor) {
    this.assertStaff(actor);
    const shipment = await this.findShipment(shipmentRef);
    return this.prisma.$queryRawUnsafe<ShipmentEscalation[]>(
      `${SELECT} where e."shipmentId" = $1 order by e."createdAt" desc, e."id" desc limit 50`,
      shipment.id,
    );
  }

  // Open: oldest first, so the longest-waiting is at the top. Resolved: newest first.
  async queue(status: unknown, actor: StaffActor) {
    this.assertStaff(actor);
    const wanted: EscalationStatus = status === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
    return this.prisma.$queryRawUnsafe<ShipmentEscalation[]>(
      `${SELECT} where e."status" = $1 order by e."createdAt" ${wanted === 'OPEN' ? 'asc' : 'desc'}, e."id" asc limit 200`,
      wanted,
    );
  }

  async raise(shipmentRef: string, reason: unknown, actor: StaffActor) {
    this.assertStaff(actor);
    const shipment = await this.findShipment(shipmentRef);
    const text = this.text(reason, 'reason');
    const id = randomUUID();
    try {
      await this.prisma.$executeRawUnsafe(
        `insert into "ShipmentEscalation" ("id", "shipmentId", "raisedById", "raisedByRole", "reason") values ($1, $2, $3, $4, $5)`,
        id, shipment.id, actor.sub, actor.role, text,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('This shipment already has an open escalation. Add to it with an internal note.');
      }
      throw error;
    }

    await this.notifications.create({
      role: 'ADMIN',
      title: `Shipment ${shipment.reference} escalated`,
      body: text.length > 200 ? `${text.slice(0, 197)}...` : text,
      tone: 'WARNING',
      entity: 'ShipmentEscalation',
      entityId: id,
      actionUrl: `/admin/shipment/${shipment.reference}`,
    }).catch((error) => this.logger.error(`Escalation ${id} saved but admins were not notified: ${String(error)}`));

    return this.byId(id);
  }

  async resolve(id: string, note: unknown, actor: StaffActor) {
    if (actor.role !== 'ADMIN') throw new ForbiddenException('Only an admin can resolve an escalation.');
    const text = this.text(note, 'resolution note');
    const updated = await this.prisma.$executeRawUnsafe(
      `update "ShipmentEscalation" set "status" = 'RESOLVED', "resolutionNote" = $2, "resolvedById" = $3, "resolvedAt" = current_timestamp
       where "id" = $1 and "status" = 'OPEN'`,
      id, text, actor.sub,
    );
    const escalation = await this.byId(id);
    if (!escalation) throw new NotFoundException('Escalation not found.');
    if (!updated) throw new ConflictException('This escalation has already been resolved.');

    if (escalation.raisedById !== actor.sub) {
      const area = escalation.raisedByRole === 'ADMIN' ? 'admin' : 'dispatcher';
      await this.notifications.create({
        userId: escalation.raisedById,
        title: `Escalation on ${escalation.shipmentReference} resolved`,
        body: text.length > 200 ? `${text.slice(0, 197)}...` : text,
        tone: 'SUCCESS',
        entity: 'ShipmentEscalation',
        entityId: id,
        actionUrl: `/${area}/shipment/${escalation.shipmentReference}`,
      }).catch((error) => this.logger.error(`Escalation ${id} resolved but the raiser was not notified: ${String(error)}`));
    }
    return escalation;
  }

  private isUniqueViolation(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    const meta = error.meta as { code?: string } | undefined;
    return error.code === 'P2002' || (error.code === 'P2010' && meta?.code === '23505');
  }
}
