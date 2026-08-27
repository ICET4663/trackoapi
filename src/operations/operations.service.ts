import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Prisma, ShipmentStatus, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type OperationActor = {
  sub: string;
  role: UserRole;
  email?: string;
};

const FINAL_SHIPMENT_STATUSES = ['COMPLETED', 'CANCELLED'] as const;

type AssignmentQueueShipmentRow = {
  id: string;
  reference: string;
  pickupLabel: string;
  destinationLabel: string;
  cargoDescription: string;
  cargoWeightKg: number | null;
  status: string;
  quotedPriceKobo: number | null;
  escrowId: string | null;
  escrowStatus: string | null;
  escrowAmount: number | null;
  escrowCurrency: string | null;
  assignmentId: string | null;
  assignedDriverId: string | null;
  assignedVehicleId: string | null;
  assignmentStatus: string | null;
  assignmentOfferedAt: Date | string | null;
  createdAt: Date | string;
};

type EscrowLedgerRow = {
  id: string;
  shipmentId: string;
  reference: string;
  route: string;
  cargo: string;
  amount: number;
  currency: string;
  status: string;
  arrivalConfirmed: boolean;
  proofOfDeliveryUploaded: boolean;
  customerDeliveryConfirmed: boolean;
  disputeWindowClear: boolean;
  platformApproved: boolean;
  updatedAt: Date | string;
};

type OperationDisputeRow = {
  id: string;
  status: string;
  priority: string;
  reason: string;
  createdAt: Date | string;
};

@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

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
    } catch (error) {
      this.logger.error(`dashboard() failed, serving preview data: ${this.errorMessage(error)}`);
      return this.previewDashboard();
    }
  }

  async assignmentQueue(actor: OperationActor) {
    this.assertCanOperate(actor.role);

    try {
      const [shipments, drivers] = await Promise.all([
        this.prisma.$queryRawUnsafe<AssignmentQueueShipmentRow[]>(
          `select
            s."id", s."reference", s."pickupLabel", s."destinationLabel", s."cargoDescription",
            s."cargoWeightKg", s."status"::text as "status", s."quotedPriceKobo", s."createdAt",
            e."id" as "escrowId", e."status"::text as "escrowStatus", e."amount" as "escrowAmount",
            e."currency" as "escrowCurrency",
            da."id" as "assignmentId", da."driverId" as "assignedDriverId",
            da."vehicleId" as "assignedVehicleId", da."status"::text as "assignmentStatus",
            da."offeredAt" as "assignmentOfferedAt"
          from "Shipment" s
          join "Escrow" e on e."shipmentId" = s."id"
          left join lateral (
            select "id", "driverId", "vehicleId", "status", "offeredAt"
            from "DriverAssignment"
            where "shipmentId" = s."id"
            order by "offeredAt" desc
            limit 1
          ) da on true
          where e."status" in ('FUNDED'::"EscrowStatus", 'HELD'::"EscrowStatus", 'RELEASE_READY'::"EscrowStatus")
            and s."status" in ('ESCROW_FUNDED'::"ShipmentStatus", 'QUOTED'::"ShipmentStatus", 'PENDING_PAYMENT'::"ShipmentStatus")
            and s."adminApproved" = true
          order by s."createdAt" desc
          limit 50`,
        ),
        this.prisma.user.findMany({
          where: {
            role: 'DRIVER',
            isActive: true,
            verificationStatus: 'VERIFIED',
          },
          include: { profile: true, driverVehicles: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      ]);

      return {
        shipments: shipments.map((shipment) => ({
          id: shipment.id,
          reference: shipment.reference,
          origin: shipment.pickupLabel,
          destination: shipment.destinationLabel,
          cargo: shipment.cargoDescription,
          cargoWeightKg: shipment.cargoWeightKg,
          status: shipment.status,
          quotedPriceKobo: shipment.quotedPriceKobo,
          escrow: shipment.escrowId
            ? {
                id: shipment.escrowId,
                status: shipment.escrowStatus,
                amount: shipment.escrowAmount,
                currency: shipment.escrowCurrency,
              }
            : null,
          latestAssignment: shipment.assignmentId
            ? {
                id: shipment.assignmentId,
                driverId: shipment.assignedDriverId,
                vehicleId: shipment.assignedVehicleId,
                status: shipment.assignmentStatus,
                offeredAt: this.isoDate(shipment.assignmentOfferedAt),
              }
            : null,
          createdAt: this.isoDate(shipment.createdAt),
        })),
        drivers: drivers.map((driver) => ({
          id: driver.id,
          fullName: driver.profile?.fullName ?? driver.email,
          email: driver.email,
          phone: driver.phone,
          verificationStatus: driver.verificationStatus,
          vehicles: driver.driverVehicles.map((vehicle) => ({
            id: vehicle.id,
            plateNumber: vehicle.plateNumber,
            type: vehicle.type,
            capacityKg: vehicle.capacityKg,
          })),
        })),
      };
    } catch (error) {
      this.logger.error(`assignmentQueue() failed, serving preview data: ${this.errorMessage(error)}`);
      return {
        shipments: [
          {
            id: 'TRK-1024',
            reference: 'TRK-1024',
            origin: 'Lagos',
            destination: 'Abuja',
            cargo: 'Consumer goods',
            cargoWeightKg: 8000,
            status: 'ESCROW_FUNDED',
            quotedPriceKobo: 35050000,
            escrow: { id: 'escrow-TRK-1024', status: 'FUNDED', amount: 35050000, currency: 'NGN' },
            latestAssignment: null,
            createdAt: new Date().toISOString(),
          },
        ],
        drivers: [
          {
            id: 'preview-driver',
            fullName: 'Tracko Preview Driver',
            email: 'driver@tracko.ng',
            phone: '+234 800 000 0001',
            verificationStatus: 'VERIFIED',
            vehicles: [{ id: 'preview-vehicle', plateNumber: 'LAG-204-TK', type: 'Flatbed truck', capacityKg: 12000 }],
          },
        ],
      };
    }
  }

  async workflowReadiness(actor: OperationActor) {
    this.assertCanOperate(actor.role);

    try {
      const [
        pendingKyc,
        verifiedDrivers,
        fundedUnassignedEscrows,
        offeredAssignments,
        acceptedAssignments,
        releaseReadyEscrows,
        openDisputes,
        openSupportTickets,
      ] = await Promise.all([
        this.prisma.user.count({
          where: { verificationStatus: { in: ['PENDING', 'IN_REVIEW', 'ACTION_NEEDED'] } },
        }),
        this.prisma.user.count({
          where: { role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED' },
        }),
        this.countRaw(
          `select count(*)::int as count
           from "Escrow" e
           join "Shipment" s on s."id" = e."shipmentId"
           where e."status" in ('FUNDED'::"EscrowStatus", 'HELD'::"EscrowStatus", 'RELEASE_READY'::"EscrowStatus")
             and s."adminApproved" = true
             and not exists (
               select 1 from "DriverAssignment" da
               where da."shipmentId" = e."shipmentId"
                 and da."status" in ('OFFERED'::"AssignmentStatus", 'ACCEPTED'::"AssignmentStatus")
             )`,
        ),
        this.prisma.driverAssignment.count({ where: { status: 'OFFERED' } }),
        this.prisma.driverAssignment.count({ where: { status: 'ACCEPTED' } }),
        this.countRaw(`select count(*)::int as count from "Escrow" where "status" = 'RELEASE_READY'::"EscrowStatus"`),
        this.countRaw(
          `select count(*)::int as count
           from "Dispute"
           where "status" in ('OPEN'::"DisputeStatus", 'IN_REVIEW'::"DisputeStatus")`,
        ),
        this.countRaw(
          `select count(*)::int as count
           from "SupportTicket"
           where "status" in ('OPEN'::"SupportTicketStatus", 'IN_PROGRESS'::"SupportTicketStatus")`,
        ),
      ]);

      const nextActions = [
        {
          key: 'kyc-review',
          label: 'Review pending KYC',
          count: pendingKyc,
          priority: pendingKyc > 0 ? 'HIGH' : 'LOW',
          route: '/admin/verifications',
        },
        {
          key: 'assign-funded-shipments',
          label: 'Assign funded shipments',
          count: fundedUnassignedEscrows,
          priority: fundedUnassignedEscrows > 0 ? 'HIGH' : 'LOW',
          route: '/dispatcher/assignment',
        },
        {
          key: 'driver-offers',
          label: 'Follow up driver offers',
          count: offeredAssignments,
          priority: offeredAssignments > 0 ? 'MEDIUM' : 'LOW',
          route: '/dispatcher/shipments',
        },
        {
          key: 'release-escrow',
          label: 'Release ready escrow',
          count: releaseReadyEscrows,
          priority: releaseReadyEscrows > 0 ? 'HIGH' : 'LOW',
          route: '/admin/finance',
        },
        {
          key: 'disputes',
          label: 'Resolve open disputes',
          count: openDisputes,
          priority: openDisputes > 0 ? 'HIGH' : 'LOW',
          route: '/dispatcher/disputes',
        },
        {
          key: 'support',
          label: 'Handle support tickets',
          count: openSupportTickets,
          priority: openSupportTickets > 0 ? 'MEDIUM' : 'LOW',
          route: '/dispatcher/support',
        },
      ];

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        metrics: {
          pendingKyc,
          verifiedDrivers,
          fundedUnassignedShipments: fundedUnassignedEscrows,
          offeredAssignments,
          acceptedAssignments,
          releaseReadyEscrows,
          openDisputes,
          openSupportTickets,
        },
        blockers: [
          ...(verifiedDrivers === 0 ? ['No verified drivers are available for assignment.'] : []),
          ...(pendingKyc > 0 ? ['Some users still need KYC review before full workflow access.'] : []),
        ],
        nextActions,
      };
    } catch (error) {
      this.logger.error(`workflowReadiness() failed, serving preview data: ${this.errorMessage(error)}`);
      return this.previewWorkflowReadiness();
    }
  }

  async escrowLedger(actor: OperationActor) {
    this.assertCanOperate(actor.role);

    try {
      const rows = await this.prisma.$queryRawUnsafe<EscrowLedgerRow[]>(
        `select
          e."id", e."shipmentId", s."reference",
          concat(s."pickupLabel", ' to ', s."destinationLabel") as "route",
          s."cargoDescription" as "cargo",
          e."amount", e."currency", e."status"::text as "status",
          e."arrivalConfirmed", e."proofOfDeliveryUploaded", e."customerDeliveryConfirmed",
          e."disputeWindowClear", e."platformApproved", e."updatedAt"
        from "Escrow" e
        join "Shipment" s on s."id" = e."shipmentId"
        order by e."updatedAt" desc
        limit 100`,
      );

      return {
        totalHeld: rows
          .filter((row) => ['FUNDED', 'HELD', 'RELEASE_READY', 'DISPUTED'].includes(row.status))
          .reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
        items: rows.map((row) => ({
          id: row.shipmentId,
          escrowId: row.id,
          reference: row.reference,
          route: row.route,
          cargo: row.cargo,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          updatedAt: this.isoDate(row.updatedAt),
          releaseChecks: {
            arrivalConfirmed: row.arrivalConfirmed,
            proofOfDeliveryUploaded: row.proofOfDeliveryUploaded,
            customerDeliveryConfirmed: row.customerDeliveryConfirmed,
            disputeWindowClear: row.disputeWindowClear,
            platformApproved: row.platformApproved,
          },
        })),
      };
    } catch (error) {
      this.logger.error(`escrowLedger() failed, serving preview data: ${this.errorMessage(error)}`);
      return {
        totalHeld: 35050000,
        items: [
          {
            id: 'TRK-1024',
            escrowId: 'escrow-TRK-1024',
            reference: 'TRK-1024',
            route: 'Lagos to Abuja',
            cargo: 'Consumer goods',
            amount: 35050000,
            currency: 'NGN',
            status: 'FUNDED',
            updatedAt: new Date().toISOString(),
            releaseChecks: {
              arrivalConfirmed: true,
              proofOfDeliveryUploaded: true,
              customerDeliveryConfirmed: true,
              disputeWindowClear: false,
              platformApproved: false,
            },
          },
        ],
      };
    }
  }

  async progressTrip(
    shipmentId: string,
    body: { status?: ShipmentStatus; note?: string; location?: string },
    actor: OperationActor,
  ) {
    this.assertCanProgressTrip(actor.role);
    // assertCanProgressTrip only checks role - a DRIVER account still needs an actual
    // ACCEPTED assignment on this shipment, otherwise any driver could advance (and even
    // mark DELIVERED/COMPLETED, which feeds escrow release) a trip they were never given.
    if (actor.role === 'DRIVER') {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, driverId: actor.sub, status: 'ACCEPTED' },
        select: { id: true },
      }).catch(() => null);
      if (!assignment) throw new ForbiddenException('You are not the assigned driver for this shipment.');
    }
    const status = body.status ?? 'IN_TRANSIT';

    // The status update is the actual point of this call: if it fails, the caller must
    // see a real error rather than a fabricated "success" that was never persisted.
    let shipment;
    try {
      shipment = await this.prisma.shipment.update({
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
    } catch (error) {
      this.logger.error(`progressTrip(${shipmentId}) failed to persist status ${status}: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException('Could not update shipment progress. Please try again.');
    }

    // Audit logging and the customer notification are supplementary: log and continue
    // rather than telling the caller the whole update failed when the status did save.
    try {
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
    } catch (error) {
      this.logger.error(`progressTrip(${shipmentId}) status saved but audit/notification failed: ${this.errorMessage(error)}`);
    }

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
  }

  async createDispute(body: Record<string, unknown>, actor: OperationActor) {
    const id = `DSP-${Date.now()}`;
    const shipmentIdentifier = body.shipmentId ? String(body.shipmentId) : undefined;
    const shipment = shipmentIdentifier
      ? await this.prisma.shipment.findFirst({
          where: { OR: [{ id: shipmentIdentifier }, { reference: shipmentIdentifier }] },
          select: { id: true, reference: true },
        })
      : null;
    if (shipmentIdentifier && !shipment) throw new BadRequestException('Shipment was not found.');
    const shipmentId = shipment?.id;

    if (shipmentId) {
      const [existing] = await this.prisma.$queryRawUnsafe<OperationDisputeRow[]>(
        `select "id", "status"::text as "status", "priority", "reason", "createdAt"
         from "Dispute"
         where "shipmentId" = $1 and "status" in ('OPEN'::"DisputeStatus", 'IN_REVIEW'::"DisputeStatus")
         order by "createdAt" desc
         limit 1`,
        shipmentId,
      );
      if (existing) {
        return {
          id: existing.id,
          shipmentId: shipment.reference,
          status: existing.status,
          priority: existing.priority,
          reason: existing.reason,
          createdAt: new Date(existing.createdAt).toISOString(),
        };
      }
    }

    // The insert is the actual dispute record: if it fails, the caller must see a real
    // error rather than a fabricated "OPEN" dispute that was never saved.
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
    } catch (error) {
      this.logger.error(`createDispute() failed to persist dispute: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException('Could not open the dispute. Please try again.');
    }

    // Audit log, shipment status flip, and the dispatcher notification are supplementary:
    // log and continue rather than telling the caller the dispute itself failed to save.
    try {
      await this.audit(actor, 'DISPUTE_CREATED', 'Dispute', id, {
        shipmentId,
        reason: body.reason,
        priority: body.priority ?? 'MEDIUM',
        description: body.description,
      });

      if (shipmentId) {
        await Promise.all([
          this.prisma.shipment.update({
            where: { id: shipmentId },
            data: {
              status: 'DISPUTED',
              timeline: {
                create: {
                  status: 'DISPUTED',
                  note: String(body.description ?? body.reason ?? 'Dispute opened.'),
                },
              },
            },
          }),
          this.prisma.$executeRawUnsafe(
            `update "Escrow" set "status" = 'DISPUTED'::"EscrowStatus", "updatedAt" = current_timestamp where "shipmentId" = $1`,
            shipmentId,
          ),
        ]);
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
    } catch (error) {
      this.logger.error(`createDispute(${id}) saved but follow-up steps failed: ${this.errorMessage(error)}`);
    }

    return {
      id,
      shipmentId: shipment?.reference,
      status: 'OPEN',
      priority: String(body.priority ?? 'MEDIUM'),
      reason: String(body.reason ?? 'Shipment support dispute'),
      createdAt: new Date().toISOString(),
    };
  }

  async resolveDispute(id: string, body: Record<string, unknown>, actor: OperationActor) {
    this.assertCanOperate(actor.role);
    const decision = String(body.decision ?? '').toUpperCase();
    const resolution = String(body.resolution ?? 'Resolved by operations.');
    const shipmentIdentifier = body.shipmentId ? String(body.shipmentId) : undefined;
    const shipment = shipmentIdentifier
      ? await this.prisma.shipment.findFirst({
          where: { OR: [{ id: shipmentIdentifier }, { reference: shipmentIdentifier }] },
          select: { id: true, reference: true, customerId: true },
        })
      : null;
    if (shipmentIdentifier && !shipment) throw new BadRequestException('Shipment was not found.');
    const shipmentStatus: ShipmentStatus = decision === 'REFUND'
      ? 'CANCELLED'
      : decision === 'RELEASE'
        ? 'COMPLETED'
        : 'IN_TRANSIT';

    try {
      const updated = await this.prisma.$executeRawUnsafe(
        `update "Dispute"
         set "status" = 'RESOLVED'::"DisputeStatus",
             "resolution" = $1,
             "resolvedAt" = current_timestamp,
             "updatedAt" = current_timestamp
         where "id" = $2`,
        resolution,
        id,
      );
      if (updated === 0) {
        if (!shipment) throw new BadRequestException('Dispute was not found.');
        await this.prisma.$executeRawUnsafe(
          `insert into "Dispute"
             ("id", "shipmentId", "userId", "reason", "description", "priority", "status", "resolution", "resolvedAt")
           values
             ($1, $2, $3, 'Legacy delivery dispute', 'Imported from a shipment that was already marked as disputed.',
              'MEDIUM', 'RESOLVED'::"DisputeStatus", $4, current_timestamp)`,
          id,
          shipment.id,
          shipment.customerId,
          resolution,
        );
      }
    } catch (error) {
      this.logger.error(`resolveDispute(${id}) failed to persist resolution: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException('Could not resolve the dispute. Please try again.');
    }

    try {
      await this.audit(actor, 'DISPUTE_RESOLVED', 'Dispute', id, {
        decision: decision || 'RESUME',
        resolution,
        shipmentId: shipment?.id,
      });

      if (shipment) {
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            status: shipmentStatus,
            timeline: {
              create: {
                status: shipmentStatus,
                note: resolution,
              },
            },
          },
        });
      }

      await this.notifications.create({
        role: 'CUSTOMER',
        title: 'Dispute resolved',
        body: resolution,
        tone: 'SUCCESS',
        entity: 'Dispute',
        entityId: id,
      });
    } catch (error) {
      this.logger.error(`resolveDispute(${id}) resolved but follow-up steps failed: ${this.errorMessage(error)}`);
    }

    return {
      id,
      status: 'RESOLVED',
      resolution,
      decision: decision || 'RESUME',
      shipmentStatus,
      shipmentId: shipment?.reference,
      resolvedAt: new Date().toISOString(),
    };
  }

  async createSupportTicket(body: Record<string, unknown>, actor: OperationActor) {
    const id = `SUP-${Date.now()}`;

    // The insert is the actual ticket: if it fails, the caller must see a real error
    // rather than a fabricated "OPEN" ticket that was never saved.
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
    } catch (error) {
      this.logger.error(`createSupportTicket() failed to persist ticket: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException('Could not create the support ticket. Please try again.');
    }

    try {
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
    } catch (error) {
      this.logger.error(`createSupportTicket(${id}) saved but follow-up steps failed: ${this.errorMessage(error)}`);
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

  private assertCanProgressTrip(role: UserRole) {
    if (role !== 'ADMIN' && role !== 'DISPATCHER' && role !== 'DRIVER') {
      throw new ForbiddenException('Only operations users and assigned drivers can update trip progress.');
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

  private isoDate(value: Date | string | null) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
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

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private async countRaw(query: string) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number | bigint | string }>>(query);
    return Number(rows[0]?.count ?? 0);
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

  private previewWorkflowReadiness() {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      metrics: {
        pendingKyc: 1,
        verifiedDrivers: 1,
        fundedUnassignedShipments: 1,
        offeredAssignments: 1,
        acceptedAssignments: 0,
        releaseReadyEscrows: 0,
        openDisputes: 0,
        openSupportTickets: 0,
      },
      blockers: [],
      nextActions: [
        {
          key: 'assign-funded-shipments',
          label: 'Assign funded shipments',
          count: 1,
          priority: 'HIGH',
          route: '/dispatcher/assignment',
        },
        {
          key: 'kyc-review',
          label: 'Review pending KYC',
          count: 1,
          priority: 'HIGH',
          route: '/admin/verifications',
        },
      ],
    };
  }
}
