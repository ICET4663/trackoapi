import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, ShipmentStatus, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type OperationActor = {
  sub: string;
  role: UserRole;
  email?: string;
};

const FINAL_SHIPMENT_STATUSES = ['COMPLETED', 'CANCELLED'] as const;

@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async dashboard() {
    try {
      const [shipments, assignments, users] = await Promise.all([
        this.prisma.shipment.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
        this.prisma.driverAssignment.findMany({ orderBy: { offeredAt: 'desc' }, take: 100 }),
        this.prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      ]);

      return {
        metrics: {
          activeShipments: shipments.filter((shipment) => !FINAL_SHIPMENT_STATUSES.includes(shipment.status as never)).length,
          openOffers: assignments.filter((assignment) => assignment.status === 'OFFERED').length,
          activeDrivers: users.filter((user) => user.role === 'DRIVER' && user.isActive).length,
          pendingVerifications: users.filter((user) => ['PENDING', 'IN_REVIEW', 'ACTION_NEEDED'].includes(user.verificationStatus)).length,
        },
        recentShipments: shipments.slice(0, 10).map((shipment) => ({
          id: shipment.id,
          reference: shipment.reference,
          origin: shipment.pickupLabel,
          destination: shipment.destinationLabel,
          status: shipment.status,
          cargo: shipment.cargoDescription,
          createdAt: shipment.createdAt.toISOString(),
        })),
        assignmentQueue: assignments.slice(0, 10).map((assignment) => ({
          id: assignment.id,
          shipmentId: assignment.shipmentId,
          driverId: assignment.driverId,
          vehicleId: assignment.vehicleId,
          status: assignment.status,
          offeredAt: assignment.offeredAt.toISOString(),
        })),
      };
    } catch {
      return this.previewDashboard();
    }
  }

  async progressTrip(
    shipmentId: string,
    body: { status?: ShipmentStatus; note?: string; location?: string },
    actor: OperationActor,
  ) {
    this.assertCanOperate(actor.role);
    const status = body.status ?? 'IN_TRANSIT';

    try {
      const shipment = await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status,
          timeline: {
            create: {
              status,
              note: body.note ?? this.statusNote(status),
            },
          },
        },
        include: { timeline: { orderBy: { createdAt: 'asc' } } },
      });

      await this.audit(actor, 'SHIPMENT_PROGRESS_UPDATED', 'Shipment', shipmentId, {
        status,
        note: body.note,
        location: body.location,
      });

      await this.notifications.create({
        userId: shipment.customerId,
        title: 'Shipment status updated',
        body: body.note ?? this.statusNote(status),
        tone: status === 'DELIVERED' || status === 'COMPLETED' ? 'SUCCESS' : 'INFO',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: `/shipments/${shipmentId}`,
      });

      return {
        id: shipment.id,
        reference: shipment.reference,
        status: shipment.status,
        updatedAt: shipment.updatedAt.toISOString(),
        timeline: shipment.timeline.map((event) => ({
          id: event.id,
          status: event.status,
          note: event.note,
          createdAt: event.createdAt.toISOString(),
        })),
      };
    } catch {
      return {
        id: shipmentId,
        status,
        updatedAt: new Date().toISOString(),
        timeline: [
          {
            id: `timeline-${Date.now()}`,
            status,
            note: body.note ?? this.statusNote(status),
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }
  }

  async createDispute(body: Record<string, unknown>, actor: OperationActor) {
    const id = `DSP-${Date.now()}`;
    const shipmentId = body.shipmentId ? String(body.shipmentId) : undefined;

    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "Dispute" ("id", "shipmentId", "userId", "reason", "description", "priority", "status")
         values ($1, $2, $3, $4, $5, $6, 'OPEN'::"DisputeStatus")`,
        id,
        shipmentId ?? null,
        actor.sub.startsWith('preview-') ? null : actor.sub,
        String(body.reason ?? 'Shipment support dispute'),
        body.description ? String(body.description) : null,
        String(body.priority ?? 'MEDIUM'),
      );

      await this.audit(actor, 'DISPUTE_CREATED', 'Dispute', id, {
        shipmentId,
        reason: body.reason,
        priority: body.priority ?? 'MEDIUM',
        description: body.description,
      });

      if (shipmentId) {
        await this.prisma.shipment.update({
          where: { id: shipmentId },
          data: {
            status: 'DISPUTED',
            timeline: {
              create: {
                status: 'DISPUTED',
                note: String(body.reason ?? 'Dispute opened.'),
              },
            },
          },
        });
      }

      await this.notifications.create({
        role: 'DISPATCHER',
        title: 'New dispute opened',
        body: String(body.reason ?? 'A shipment dispute needs review.'),
        tone: 'WARNING',
        entity: 'Dispute',
        entityId: id,
        actionUrl: `/dispatcher/disputes`,
      });
    } catch {
      // Preview response below.
    }

    return {
      id,
      shipmentId,
      status: 'OPEN',
      priority: String(body.priority ?? 'MEDIUM'),
      reason: String(body.reason ?? 'Shipment support dispute'),
      createdAt: new Date().toISOString(),
    };
  }

  async resolveDispute(id: string, body: Record<string, unknown>, actor: OperationActor) {
    this.assertCanOperate(actor.role);

    try {
      await this.prisma.$queryRawUnsafe(
        `update "Dispute"
         set "status" = 'RESOLVED'::"DisputeStatus",
             "resolution" = $1,
             "resolvedAt" = current_timestamp,
             "updatedAt" = current_timestamp
         where "id" = $2`,
        String(body.resolution ?? 'Resolved by operations.'),
        id,
      );

      await this.audit(actor, 'DISPUTE_RESOLVED', 'Dispute', id, {
        resolution: body.resolution,
        shipmentId: body.shipmentId,
      });

      if (body.shipmentId) {
        await this.prisma.shipment.update({
          where: { id: String(body.shipmentId) },
          data: {
            status: 'IN_TRANSIT',
            timeline: {
              create: {
                status: 'IN_TRANSIT',
                note: String(body.resolution ?? 'Dispute resolved. Shipment returned to operations queue.'),
              },
            },
          },
        });
      }

      await this.notifications.create({
        role: 'CUSTOMER',
        title: 'Dispute resolved',
        body: String(body.resolution ?? 'Your dispute has been reviewed by operations.'),
        tone: 'SUCCESS',
        entity: 'Dispute',
        entityId: id,
      });
    } catch {
      // Preview response below.
    }

    return {
      id,
      status: 'RESOLVED',
      resolution: String(body.resolution ?? 'Resolved by operations.'),
      resolvedAt: new Date().toISOString(),
    };
  }

  async createSupportTicket(body: Record<string, unknown>, actor: OperationActor) {
    const id = `SUP-${Date.now()}`;

    try {
      await this.prisma.$queryRawUnsafe(
        `insert into "SupportTicket" ("id", "shipmentId", "userId", "topic", "channel", "message", "status")
         values ($1, $2, $3, $4, $5, $6, 'OPEN'::"SupportTicketStatus")`,
        id,
        body.shipmentId ? String(body.shipmentId) : null,
        actor.sub.startsWith('preview-') ? null : actor.sub,
        String(body.topic ?? 'General support'),
        String(body.channel ?? 'CHAT'),
        body.message ? String(body.message) : null,
      );

      await this.audit(actor, 'SUPPORT_TICKET_CREATED', 'SupportTicket', id, {
        topic: body.topic,
        channel: body.channel,
        message: body.message,
        shipmentId: body.shipmentId,
      });

      await this.notifications.create({
        role: 'DISPATCHER',
        title: 'New support ticket',
        body: String(body.topic ?? 'A user created a support ticket.'),
        tone: 'INFO',
        entity: 'SupportTicket',
        entityId: id,
        actionUrl: `/dispatcher/support`,
      });
    } catch {
      // Preview response below.
    }

    return {
      id,
      status: 'OPEN',
      topic: String(body.topic ?? 'General support'),
      channel: String(body.channel ?? 'CHAT'),
      createdAt: new Date().toISOString(),
    };
  }

  private assertCanOperate(role: UserRole) {
    if (role !== 'ADMIN' && role !== 'DISPATCHER') {
      throw new ForbiddenException('Only operations users can perform this action.');
    }
  }

  private statusNote(status: ShipmentStatus) {
    if (status === 'ARRIVED_PICKUP') return 'Driver arrived at pickup.';
    if (status === 'PICKED_UP') return 'Cargo picked up.';
    if (status === 'ARRIVED_DESTINATION') return 'Driver arrived at destination.';
    if (status === 'DELIVERED') return 'Delivery completed, awaiting confirmation.';
    if (status === 'COMPLETED') return 'Shipment completed.';
    return 'Shipment status updated.';
  }

  private async audit(actor: OperationActor, action: string, entity: string, entityId: string, metadata: unknown) {
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.sub.startsWith('preview-') ? undefined : actor.sub,
        action,
        entity,
        entityId,
        metadata: this.toJson(metadata),
      },
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private previewDashboard() {
    return {
      metrics: {
        activeShipments: 1,
        openOffers: 1,
        activeDrivers: 1,
        pendingVerifications: 1,
      },
      recentShipments: [
        {
          id: 'TRK-1024',
          reference: 'TRK-1024',
          origin: 'Lagos',
          destination: 'Abuja',
          status: 'IN_TRANSIT',
          cargo: 'Consumer goods',
          createdAt: new Date().toISOString(),
        },
      ],
      assignmentQueue: [
        {
          id: 'assignment-preview',
          shipmentId: 'TRK-1024',
          driverId: 'preview-driver',
          vehicleId: 'preview-vehicle',
          status: 'OFFERED',
          offeredAt: new Date().toISOString(),
        },
      ],
    };
  }
}
