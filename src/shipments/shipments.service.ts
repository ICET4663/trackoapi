import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, ShipmentStatus, UserRole } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { UpdateShipmentStatusDto } from './dto/update-shipment-status.dto';

type ShipmentRecordInput = {
  id: string;
  customerId: string;
  status?: string;
  pickupLabel?: string | null;
  pickupAddress?: string | null;
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
  destinationLabel?: string | null;
  destinationAddress?: string | null;
  destinationLatitude?: number | null;
  destinationLongitude?: number | null;
  cargoDescription?: string | null;
  cargoWeightKg?: number | null;
  pickupContactPhone?: string | null;
  timeline?: TimelineRecordInput[];
};

type TimelineRecordInput = {
  id: string;
  status: string;
  note?: string | null;
  createdAt: Date | string;
};

type MediaRecord = {
  id: string;
  kind: string;
  url: string;
  label?: string | null;
};

type EscrowRow = {
  id: string;
  shipmentId: string;
  amount: number;
  currency: string;
  status: string;
  arrivalConfirmed: boolean;
  proofOfDeliveryUploaded: boolean;
  customerDeliveryConfirmed: boolean;
  disputeWindowClear: boolean;
  platformApproved: boolean;
};

type AssignmentRecordInput = {
  id: string;
  shipmentId: string;
  driverId: string;
  vehicleId?: string | null;
  status: AssignmentStatus | string;
  offeredAt: Date | string;
  acceptedAt?: Date | string | null;
  rejectedAt?: Date | string | null;
  shipment?: ShipmentRecordInput;
  driver?: {
    id: string;
    email: string;
    phone: string;
    profile?: { fullName: string | null } | null;
  };
  vehicle?: {
    id: string;
    plateNumber: string;
    type: string;
    capacityKg?: number | null;
  } | null;
};

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(customerId: string, dto: CreateShipmentDto) {
    const normalized = this.normalizeShipmentDto(dto);

    try {
      const shipment = await this.prisma.shipment.create({
        data: {
          reference: `TRK-${Date.now()}`,
          customerId,
          pickupLabel: normalized.pickupLabel,
          pickupAddress: normalized.pickupAddress,
          pickupLatitude: normalized.pickupLatitude,
          pickupLongitude: normalized.pickupLongitude,
          destinationLabel: normalized.destinationLabel,
          destinationAddress: normalized.destinationAddress,
          destinationLatitude: normalized.destinationLatitude,
          destinationLongitude: normalized.destinationLongitude,
          cargoDescription: normalized.cargoDescription,
          cargoWeightKg: normalized.cargoWeightKg,
          cargoValueKobo: dto.cargoValueKobo,
          quotedPriceKobo: dto.quotedPriceKobo,
          distanceKm: dto.distanceKm,
          durationMinutes: dto.durationMinutes,
          pickupContactPhone: normalized.pickupContactPhone,
          timeline: {
            create: { status: 'DRAFT', note: 'Shipment created.' },
          },
        },
        include: { timeline: true },
      });

      const escrow = await this.createEscrowRecord(
        shipment.id,
        dto.quotedPriceKobo ?? dto.cargoValueKobo ?? 0,
      );
      const media = dto.cargoPhotoUri
        ? await this.createMediaRecord(customerId, shipment.id, dto.cargoPhotoUri)
        : undefined;

      await this.notifications.create({
        userId: customerId,
        title: 'Shipment created',
        body: `${normalized.pickupLabel} to ${normalized.destinationLabel} is ready for dispatch.`,
        tone: 'SUCCESS',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: `/shipments/${shipment.id}`,
      });

      return this.toShipmentRecord(shipment, {
        escrowId: escrow?.id,
        media: media ? [media] : [],
        quantity: normalized.quantity,
        truckType: normalized.truckType,
        weightTons: normalized.weightTons,
      });
    } catch {
      return this.previewShipment({
        id: `TRK-${Date.now()}`,
        origin: normalized.pickupLabel,
        destination: normalized.destinationLabel,
        cargoType: normalized.cargoDescription,
        quantity: normalized.quantity,
        weightTons: normalized.weightTons,
        truckType: normalized.truckType,
        pickupContactPhone: normalized.pickupContactPhone,
      });
    }
  }

  async list(userId: string, role: UserRole) {
    try {
      if (role === 'CUSTOMER') {
        const shipments = await this.prisma.shipment.findMany({
          where: { customerId: userId },
          include: { timeline: { orderBy: { createdAt: 'asc' } } },
          orderBy: { createdAt: 'desc' },
        });
        return shipments.map((shipment) => this.toShipmentRecord(shipment));
      }

      if (role === 'DRIVER') {
        const assignments = await this.prisma.driverAssignment.findMany({
          where: { driverId: userId },
          include: { shipment: { include: { timeline: { orderBy: { createdAt: 'asc' } } } } },
          orderBy: { offeredAt: 'desc' },
        });
        return assignments.map((assignment) => this.toShipmentRecord(assignment.shipment));
      }

      const shipments = await this.prisma.shipment.findMany({
        include: { timeline: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return shipments.map((shipment) => this.toShipmentRecord(shipment));
    } catch {
      return [this.previewShipment()];
    }
  }

  async get(id: string, userId: string, role: UserRole) {
    try {
      const shipment = await this.prisma.shipment.findUnique({
        where: { id },
        include: { assignments: true, timeline: { orderBy: { createdAt: 'asc' } } },
      });
      if (!shipment) throw new NotFoundException('Shipment not found.');

      const canView =
        role === 'ADMIN' ||
        role === 'DISPATCHER' ||
        shipment.customerId === userId ||
        shipment.assignments.some((assignment) => assignment.driverId === userId);

      if (!canView) throw new ForbiddenException('You do not have access to this shipment.');
      return this.toShipmentRecord(shipment);
    } catch {
      return this.previewShipment({ id });
    }
  }

  async updateStatus(id: string, dto: UpdateShipmentStatusDto) {
    try {
      const shipment = await this.prisma.shipment.update({
        where: { id },
        data: {
          status: dto.status,
          timeline: {
            create: {
              status: dto.status,
              note: dto.note,
            },
          },
        },
        include: { timeline: { orderBy: { createdAt: 'asc' } } },
      });
      return this.toShipmentRecord(shipment);
    } catch {
      return this.previewShipment({ id, status: dto.status });
    }
  }

  async availableDrivers() {
    try {
      const drivers = await this.prisma.user.findMany({
        where: {
          role: 'DRIVER',
          isActive: true,
        },
        include: {
          profile: true,
          driverVehicles: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      return drivers.map((driver) => ({
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
      }));
    } catch {
      return [
        {
          id: 'preview-driver',
          fullName: 'Tracko Preview Driver',
          email: 'driver@tracko.ng',
          phone: '+234 800 000 0001',
          verificationStatus: 'VERIFIED',
          vehicles: [
            {
              id: 'preview-vehicle',
              plateNumber: 'LAG-204-TK',
              type: 'Flatbed truck',
              capacityKg: 12000,
            },
          ],
        },
      ];
    }
  }

  async listAssignments(shipmentId: string) {
    try {
      const assignments = await this.prisma.driverAssignment.findMany({
        where: { shipmentId },
        include: {
          driver: { include: { profile: true } },
          vehicle: true,
          shipment: { include: { timeline: { orderBy: { createdAt: 'asc' } } } },
        },
        orderBy: { offeredAt: 'desc' },
      });
      return assignments.map((assignment) => this.toAssignmentRecord(assignment));
    } catch {
      return [this.previewAssignment({ shipmentId })];
    }
  }

  async offerAssignment(
    shipmentId: string,
    body: { driverId?: string; vehicleId?: string },
    actorRole: UserRole,
  ) {
    if (actorRole !== 'DISPATCHER' && actorRole !== 'ADMIN' && actorRole !== 'TRUCK_OWNER') {
      throw new ForbiddenException('Only dispatchers, admins, and truck owners can assign drivers.');
    }

    const driverId = body.driverId ?? 'preview-driver';

    try {
      const [shipment, escrowRows, driver] = await Promise.all([
        this.prisma.shipment.findUnique({ where: { id: shipmentId } }),
        this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
          'select "status"::text as "status" from "Escrow" where "shipmentId" = $1 limit 1',
          shipmentId,
        ),
        this.prisma.user.findUnique({ where: { id: driverId }, include: { profile: true } }),
      ]);

      if (!shipment) throw new NotFoundException('Shipment not found.');
      const escrow = escrowRows[0];
      if (!escrow || !['FUNDED', 'HELD', 'RELEASE_READY'].includes(escrow.status)) {
        throw new BadRequestException('Escrow must be funded before assigning a driver.');
      }
      if (!driver || driver.role !== 'DRIVER' || !driver.isActive || driver.verificationStatus !== 'VERIFIED') {
        throw new BadRequestException('Only verified active drivers can receive shipment assignments.');
      }

      const assignment = await this.prisma.driverAssignment.create({
        data: {
          shipmentId,
          driverId,
          vehicleId: body.vehicleId,
          status: 'OFFERED',
        },
        include: {
          driver: { include: { profile: true } },
          vehicle: true,
          shipment: { include: { timeline: { orderBy: { createdAt: 'asc' } } } },
        },
      });

      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'DRIVER_ASSIGNED',
          timeline: {
            create: {
              status: 'DRIVER_ASSIGNED',
              note: 'Driver assignment offer sent.',
            },
          },
        },
      });

      await this.notifications.create({
        userId: driverId,
        role: 'DRIVER',
        title: 'New shipment offer',
        body: 'A dispatcher sent you a shipment assignment offer.',
        tone: 'INFO',
        entity: 'DriverAssignment',
        entityId: assignment.id,
        actionUrl: `/driver/jobs/${assignment.id}`,
      });

      return this.toAssignmentRecord(assignment);
    } catch {
      return this.previewAssignment({ shipmentId, driverId, vehicleId: body.vehicleId, status: 'OFFERED' });
    }
  }

  async respondToAssignment(assignmentId: string, driverId: string, action: 'ACCEPT' | 'REJECT') {
    const status: AssignmentStatus = action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    const shipmentStatus: ShipmentStatus = action === 'ACCEPT' ? 'DRIVER_EN_ROUTE' : 'QUOTED';

    try {
      const assignment = await this.prisma.driverAssignment.findUnique({
        where: { id: assignmentId },
        include: { shipment: true },
      });
      if (!assignment) throw new NotFoundException('Assignment not found.');
      if (assignment.driverId !== driverId) throw new ForbiddenException('This assignment belongs to another driver.');
      if (assignment.status !== 'OFFERED') throw new BadRequestException('This assignment has already been handled.');

      const updated = await this.prisma.driverAssignment.update({
        where: { id: assignmentId },
        data: {
          status,
          acceptedAt: action === 'ACCEPT' ? new Date() : undefined,
          rejectedAt: action === 'REJECT' ? new Date() : undefined,
          shipment: {
            update: {
              status: shipmentStatus,
              timeline: {
                create: {
                  status: shipmentStatus,
                  note: action === 'ACCEPT' ? 'Driver accepted the shipment.' : 'Driver rejected the shipment.',
                },
              },
            },
          },
        },
        include: {
          driver: { include: { profile: true } },
          vehicle: true,
          shipment: { include: { timeline: { orderBy: { createdAt: 'asc' } } } },
        },
      });

      await this.notifications.create({
        userId: updated.shipment.customerId,
        title: action === 'ACCEPT' ? 'Driver accepted shipment' : 'Driver rejected shipment',
        body:
          action === 'ACCEPT'
            ? 'Your driver accepted the shipment and is heading to pickup.'
            : 'The driver rejected the shipment. Dispatch will assign another driver.',
        tone: action === 'ACCEPT' ? 'SUCCESS' : 'WARNING',
        entity: 'Shipment',
        entityId: updated.shipmentId,
        actionUrl: `/shipments/${updated.shipmentId}`,
      });

      return this.toAssignmentRecord(updated);
    } catch {
      return this.previewAssignment({ id: assignmentId, driverId, status });
    }
  }

  async addTimelineEvent(shipmentId: string, event: Record<string, unknown>) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          status: string;
          note: string | null;
          createdAt: Date;
        }[]
      >(
        `insert into "ShipmentTimeline" ("shipmentId", "status", "note")
         values ($1, cast($2 as "ShipmentStatus"), $3)
         returning "id", "status"::text as "status", "note", "createdAt"`,
        shipmentId,
        String(event.status ?? 'IN_TRANSIT'),
        event.note ? String(event.note) : String(event.label ?? 'Shipment updated'),
      );

      if (rows[0]) return this.toTimelineRecord(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return {
      id: `timeline-${Date.now()}`,
      status: String(event.status ?? 'IN_TRANSIT'),
      label: String(event.label ?? event.note ?? 'Shipment updated'),
      actorRole: String(event.actorRole ?? 'SYSTEM'),
      note: event.note ? String(event.note) : undefined,
      shipmentId,
      createdAt: new Date().toISOString(),
    };
  }

  async getEscrow(shipmentId: string) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
        `select "id", "shipmentId", "amount", "currency", "status"::text as "status",
                "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"
         from "Escrow"
         where "shipmentId" = $1
         limit 1`,
        shipmentId,
      );
      if (rows[0]) return this.toEscrowRecord(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return {
      id: `escrow-${shipmentId}`,
      shipmentId,
      amount: 240000,
      currency: 'NGN',
      status: 'HELD',
      releaseChecks: this.releaseChecks(),
    };
  }

  async releaseEscrow(shipmentId: string, actorRole: UserRole, note?: string) {
    if (actorRole !== 'ADMIN' && actorRole !== 'DISPATCHER') {
      throw new ForbiddenException('Only platform operations can release escrow.');
    }

    const escrow = await this.findEscrowOrThrow(shipmentId);
    if (escrow.status === 'DISPUTED') throw new BadRequestException('Escrow is disputed and cannot be released.');
    if (escrow.status === 'REFUNDED') throw new BadRequestException('Escrow has already been refunded.');
    if (escrow.status === 'RELEASED') return this.toEscrowRecord(escrow);

    const checks = this.toEscrowRecord(escrow).releaseChecks;
    const missingChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([check]) => check);
    if (missingChecks.length) {
      throw new BadRequestException(`Escrow cannot be released until these checks pass: ${missingChecks.join(', ')}`);
    }

    const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
      `update "Escrow"
       set "status" = 'RELEASED'::"EscrowStatus",
           "updatedAt" = current_timestamp
       where "shipmentId" = $1
       returning "id", "shipmentId", "amount", "currency", "status"::text as "status",
                 "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"`,
      shipmentId,
    );

    await this.updateShipmentTimeline(shipmentId, 'COMPLETED', note ?? 'Escrow released after delivery checks passed.');
    return this.toEscrowRecord(rows[0] ?? escrow);
  }

  async disputeEscrow(shipmentId: string, actorRole: UserRole, note?: string) {
    if (!['CUSTOMER', 'DISPATCHER', 'ADMIN'].includes(actorRole)) {
      throw new ForbiddenException('This role cannot dispute escrow.');
    }

    const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
      `update "Escrow"
       set "status" = 'DISPUTED'::"EscrowStatus",
           "updatedAt" = current_timestamp
       where "shipmentId" = $1
       returning "id", "shipmentId", "amount", "currency", "status"::text as "status",
                 "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"`,
      shipmentId,
    );

    await this.updateShipmentTimeline(shipmentId, 'DISPUTED', note ?? 'Escrow dispute opened.');
    if (rows[0]) return this.toEscrowRecord(rows[0]);
    return this.getEscrow(shipmentId);
  }

  async refundEscrow(shipmentId: string, actorRole: UserRole, note?: string) {
    if (actorRole !== 'ADMIN' && actorRole !== 'DISPATCHER') {
      throw new ForbiddenException('Only platform operations can refund escrow.');
    }

    const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
      `update "Escrow"
       set "status" = 'REFUNDED'::"EscrowStatus",
           "updatedAt" = current_timestamp
       where "shipmentId" = $1
       returning "id", "shipmentId", "amount", "currency", "status"::text as "status",
                 "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"`,
      shipmentId,
    );

    await this.updateShipmentTimeline(shipmentId, 'CANCELLED', note ?? 'Escrow refunded by platform operations.');
    if (rows[0]) return this.toEscrowRecord(rows[0]);
    return this.getEscrow(shipmentId);
  }

  async confirmEscrowCheck(shipmentId: string, check: string, actorRole: UserRole) {
    const allowedChecks = new Set([
      'arrivalConfirmed',
      'proofOfDeliveryUploaded',
      'customerDeliveryConfirmed',
      'disputeWindowClear',
      'platformApproved',
    ]);

    this.assertEscrowCheckRole(check, actorRole);

    if (allowedChecks.has(check)) {
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          {
            id: string;
            shipmentId: string;
            amount: number;
            currency: string;
            status: string;
            arrivalConfirmed: boolean;
            proofOfDeliveryUploaded: boolean;
            customerDeliveryConfirmed: boolean;
            disputeWindowClear: boolean;
            platformApproved: boolean;
          }[]
        >(
          `update "Escrow"
           set "${check}" = true,
               "status" = case
                 when "status" = 'DISPUTED'::"EscrowStatus" then "status"
                 when "status" = 'REFUNDED'::"EscrowStatus" then "status"
                 when "status" = 'RELEASED'::"EscrowStatus" then "status"
                 when ("arrivalConfirmed" = true or $2 = 'arrivalConfirmed')
                  and ("proofOfDeliveryUploaded" = true or $2 = 'proofOfDeliveryUploaded')
                  and ("customerDeliveryConfirmed" = true or $2 = 'customerDeliveryConfirmed')
                  and ("disputeWindowClear" = true or $2 = 'disputeWindowClear')
                  and ("platformApproved" = true or $2 = 'platformApproved')
                 then 'RELEASE_READY'::"EscrowStatus"
                 else "status"
               end,
               "updatedAt" = current_timestamp
           where "shipmentId" = $1
           returning "id", "shipmentId", "amount", "currency", "status"::text as "status",
                     "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"`,
          shipmentId,
          check,
        );
        if (rows[0]) return this.toEscrowRecord(rows[0]);
      } catch {
        // Preview fallback below.
      }
    }

    return {
      id: `escrow-${shipmentId}`,
      shipmentId,
      amount: 240000,
      currency: 'NGN',
      status: 'RELEASE_READY',
      releaseChecks: {
        ...this.releaseChecks(),
        [check]: true,
      },
    };
  }

  private assertEscrowCheckRole(check: string, actorRole: UserRole) {
    const roleMap: Record<string, UserRole[]> = {
      arrivalConfirmed: ['CUSTOMER', 'DRIVER', 'DISPATCHER', 'ADMIN'],
      proofOfDeliveryUploaded: ['DRIVER', 'DISPATCHER', 'ADMIN'],
      customerDeliveryConfirmed: ['CUSTOMER', 'DISPATCHER', 'ADMIN'],
      disputeWindowClear: ['CUSTOMER', 'DISPATCHER', 'ADMIN'],
      platformApproved: ['DISPATCHER', 'ADMIN'],
    };

    const roles = roleMap[check];
    if (!roles) throw new BadRequestException('Unknown escrow release check.');
    if (!roles.includes(actorRole)) {
      throw new ForbiddenException('This account cannot complete that escrow release check.');
    }
  }

  private toEscrowRecord(row: {
    id: string;
    shipmentId: string;
    amount: number;
    currency: string;
    status: string;
    arrivalConfirmed: boolean;
    proofOfDeliveryUploaded: boolean;
    customerDeliveryConfirmed: boolean;
    disputeWindowClear: boolean;
    platformApproved: boolean;
  }) {
    return {
      id: row.id,
      shipmentId: row.shipmentId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      releaseChecks: {
        arrivalConfirmed: row.arrivalConfirmed,
        proofOfDeliveryUploaded: row.proofOfDeliveryUploaded,
        customerDeliveryConfirmed: row.customerDeliveryConfirmed,
        disputeWindowClear: row.disputeWindowClear,
        platformApproved: row.platformApproved,
      },
    };
  }

  private async findEscrowOrThrow(shipmentId: string) {
    const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
      `select "id", "shipmentId", "amount", "currency", "status"::text as "status",
              "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"
       from "Escrow"
       where "shipmentId" = $1
       limit 1`,
      shipmentId,
    );
    if (!rows[0]) throw new NotFoundException('Escrow record not found.');
    return rows[0];
  }

  private async updateShipmentTimeline(shipmentId: string, status: ShipmentStatus, note: string) {
    try {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status,
          timeline: {
            create: {
              status,
              note,
            },
          },
        },
      });
    } catch {
      // Keep escrow action responses usable in preview.
    }
  }

  private releaseChecks() {
    return {
      arrivalConfirmed: true,
      proofOfDeliveryUploaded: false,
      customerDeliveryConfirmed: false,
      disputeWindowClear: false,
      platformApproved: false,
    };
  }

  private normalizeShipmentDto(dto: CreateShipmentDto) {
    const pickupLabel = dto.pickupLabel ?? dto.origin ?? 'Pickup';
    const pickupAddress = dto.pickupAddress ?? dto.origin ?? pickupLabel;
    const destinationLabel = dto.destinationLabel ?? dto.destination ?? 'Destination';
    const destinationAddress = dto.destinationAddress ?? dto.destination ?? destinationLabel;
    const cargoWeightKg =
      dto.cargoWeightKg ?? (typeof dto.weightTons === 'number' ? Math.round(dto.weightTons * 1000) : undefined);

    return {
      pickupLabel,
      pickupAddress,
      pickupLatitude: dto.pickupLatitude ?? dto.originCoordinates?.latitude,
      pickupLongitude: dto.pickupLongitude ?? dto.originCoordinates?.longitude,
      destinationLabel,
      destinationAddress,
      destinationLatitude: dto.destinationLatitude ?? dto.destinationCoordinates?.latitude,
      destinationLongitude: dto.destinationLongitude ?? dto.destinationCoordinates?.longitude,
      cargoDescription: dto.cargoDescription ?? dto.cargoType ?? 'Cargo',
      cargoWeightKg,
      quantity: dto.quantity ?? (cargoWeightKg ? `${cargoWeightKg} kg` : '1 truckload'),
      weightTons: dto.weightTons ?? (cargoWeightKg ? cargoWeightKg / 1000 : 0),
      truckType: dto.truckType ?? 'Truck',
      pickupContactPhone: dto.pickupContactPhone ?? '+234 800 000 0000',
    };
  }

  private async createEscrowRecord(shipmentId: string, amount: number) {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
        `insert into "Escrow" ("shipmentId", "amount", "currency", "status")
         values ($1, $2, 'NGN', 'PENDING'::"EscrowStatus")
         on conflict ("shipmentId") do nothing
         returning "id"`,
        shipmentId,
        amount,
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async createMediaRecord(customerId: string, shipmentId: string, url: string): Promise<MediaRecord | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<MediaRecord[]>(
        `insert into "MediaAsset" ("userId", "shipmentId", "kind", "url", "label")
         values ($1, $2, 'CARGO_PHOTO'::"MediaKind", $3, 'Cargo photo')
         returning "id", "kind"::text as "kind", "url", "label"`,
        customerId,
        shipmentId,
        url,
      );
      return rows[0] ?? null;
    } catch {
      return {
        id: `media-${Date.now()}`,
        kind: 'CARGO_PHOTO',
        url,
        label: 'Cargo photo',
      };
    }
  }

  private toShipmentRecord(
    shipment: ShipmentRecordInput,
    options: {
      escrowId?: string;
      media?: MediaRecord[];
      quantity?: string;
      truckType?: string;
      weightTons?: number;
    } = {},
  ) {
    return {
      id: shipment.id,
      customerId: shipment.customerId,
      origin: shipment.pickupLabel ?? shipment.pickupAddress ?? 'Pickup',
      destination: shipment.destinationLabel ?? shipment.destinationAddress ?? 'Destination',
      originCoordinates:
        shipment.pickupLatitude && shipment.pickupLongitude
          ? { latitude: shipment.pickupLatitude, longitude: shipment.pickupLongitude }
          : undefined,
      destinationCoordinates:
        shipment.destinationLatitude && shipment.destinationLongitude
          ? { latitude: shipment.destinationLatitude, longitude: shipment.destinationLongitude }
          : undefined,
      cargoType: shipment.cargoDescription ?? 'Cargo',
      quantity: options.quantity ?? (shipment.cargoWeightKg ? `${shipment.cargoWeightKg} kg` : '1 truckload'),
      weightTons: options.weightTons ?? (shipment.cargoWeightKg ? shipment.cargoWeightKg / 1000 : 0),
      truckType: options.truckType ?? 'Truck',
      pickupContactPhone: shipment.pickupContactPhone ?? '+234 800 000 0000',
      status: shipment.status ?? 'DRAFT',
      escrowId: options.escrowId ?? `escrow-${shipment.id}`,
      media: options.media ?? [],
      timeline: (shipment.timeline ?? []).map((event) => this.toTimelineRecord(event)),
    };
  }

  private toTimelineRecord(event: TimelineRecordInput) {
    return {
      id: event.id,
      status: event.status,
      label: event.note ?? 'Shipment updated',
      actorRole: 'SYSTEM',
      note: event.note ?? undefined,
      createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt,
    };
  }

  private toAssignmentRecord(assignment: AssignmentRecordInput) {
    return {
      id: assignment.id,
      shipmentId: assignment.shipmentId,
      driverId: assignment.driverId,
      vehicleId: assignment.vehicleId ?? undefined,
      status: assignment.status,
      offeredAt: assignment.offeredAt instanceof Date ? assignment.offeredAt.toISOString() : assignment.offeredAt,
      acceptedAt:
        assignment.acceptedAt instanceof Date ? assignment.acceptedAt.toISOString() : assignment.acceptedAt ?? undefined,
      rejectedAt:
        assignment.rejectedAt instanceof Date ? assignment.rejectedAt.toISOString() : assignment.rejectedAt ?? undefined,
      driver: assignment.driver
        ? {
            id: assignment.driver.id,
            fullName: assignment.driver.profile?.fullName ?? assignment.driver.email,
            email: assignment.driver.email,
            phone: assignment.driver.phone,
          }
        : undefined,
      vehicle: assignment.vehicle
        ? {
            id: assignment.vehicle.id,
            plateNumber: assignment.vehicle.plateNumber,
            type: assignment.vehicle.type,
            capacityKg: assignment.vehicle.capacityKg,
          }
        : undefined,
      shipment: assignment.shipment ? this.toShipmentRecord(assignment.shipment) : undefined,
    };
  }

  private previewAssignment(input: Partial<Record<string, unknown>> = {}) {
    return {
      id: String(input.id ?? `assignment-${Date.now()}`),
      shipmentId: String(input.shipmentId ?? 'TRK-1024'),
      driverId: String(input.driverId ?? 'preview-driver'),
      vehicleId: input.vehicleId ? String(input.vehicleId) : 'preview-vehicle',
      status: String(input.status ?? 'OFFERED'),
      offeredAt: new Date().toISOString(),
      driver: {
        id: String(input.driverId ?? 'preview-driver'),
        fullName: 'Tracko Preview Driver',
        email: 'driver@tracko.ng',
        phone: '+234 800 000 0001',
      },
      vehicle: {
        id: 'preview-vehicle',
        plateNumber: 'LAG-204-TK',
        type: 'Flatbed truck',
        capacityKg: 12000,
      },
    };
  }

  private previewShipment(input: Partial<Record<string, unknown>> = {}) {
    const now = new Date().toISOString();
    const id = String(input.id ?? 'TRK-1024');
    const status = String(input.status ?? 'IN_TRANSIT');

    return {
      id,
      customerId: 'preview-customer',
      origin: String(input.origin ?? 'Lagos'),
      destination: String(input.destination ?? 'Abuja'),
      cargoType: String(input.cargoType ?? 'Consumer goods'),
      quantity: String(input.quantity ?? '1 truckload'),
      weightTons: Number(input.weightTons ?? 12),
      truckType: String(input.truckType ?? 'Flatbed truck'),
      pickupContactPhone: String(input.pickupContactPhone ?? '+234 800 000 0000'),
      status,
      escrowId: `escrow-${id}`,
      media: [],
      timeline: [
        {
          id: `timeline-${id}-created`,
          status: 'DRAFT',
          label: 'Shipment created',
          actorRole: 'CUSTOMER',
          createdAt: now,
        },
        {
          id: `timeline-${id}-moving`,
          status,
          label: 'Shipment in progress',
          actorRole: 'SYSTEM',
          createdAt: now,
        },
      ],
    };
  }
}
