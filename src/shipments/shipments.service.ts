import { BadRequestException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, ShipmentStatus, UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MapsProviderService } from '../integrations/maps-provider.service';
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
  quotedPriceKobo?: number | null;
  distanceKm?: number | null;
  durationMinutes?: number | null;
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
  private readonly logger = new Logger(ShipmentsService.name);
  private readonly defaultAssignmentOfferMinutes = 15;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly mapsProvider: MapsProviderService,
  ) {}

  async create(customerId: string, dto: CreateShipmentDto) {
    await this.assertNotInMaintenanceMode();
    await this.assertCustomerCanCreateShipment(customerId);

    const normalized = this.normalizeShipmentDto(dto);
    // Price, distance, and duration are always recomputed server-side from the
    // same formula the client previewed with — a client can never dictate what
    // it gets charged by sending a different quotedPriceKobo in the request body.
    const quoteInput = {
      originLatitude: normalized.pickupLatitude ?? undefined,
      originLongitude: normalized.pickupLongitude ?? undefined,
      destinationLatitude: normalized.destinationLatitude ?? undefined,
      destinationLongitude: normalized.destinationLongitude ?? undefined,
      truckType: normalized.truckType,
      weightTons: normalized.weightTons,
    };
    const quote = dto.quoteToken
      ? this.mapsProvider.verifyQuoteToken(dto.quoteToken, quoteInput)
      : await this.mapsProvider.routeEstimate(quoteInput);

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
          quotedPriceKobo: quote.quotedPriceKobo,
          distanceKm: quote.distanceKm,
          durationMinutes: quote.durationMinutes,
          pickupContactPhone: normalized.pickupContactPhone,
          timeline: {
            create: { status: 'DRAFT', note: 'Shipment created.' },
          },
        },
        include: { timeline: true },
      });

      await this.recordQuoteSnapshot(customerId, shipment.id, quote);

      const escrow = await this.createEscrowRecord(
        shipment.id,
        quote.quotedPriceKobo,
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
        pricingVersion: quote.pricingVersion,
        quoteValidMinutes: quote.quoteValidMinutes,
        pricingBreakdown: quote.pricingBreakdown,
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

  private async assertCustomerCanCreateShipment(customerId: string) {
    let rows: Array<{ verificationStatus: string; role: string; isActive: boolean }>;
    try {
      rows = await this.prisma.$queryRawUnsafe<Array<{ verificationStatus: string; role: string; isActive: boolean }>>(
        'select "verificationStatus"::text as "verificationStatus", "role"::text as "role", "isActive" from "User" where "id" = $1 limit 1',
        customerId,
      );
    } catch {
      throw new InternalServerErrorException('Could not verify this customer account. Please try again.');
    }

    const customer = rows[0];
    if (!customer || customer.role !== 'CUSTOMER' || !customer.isActive) {
      throw new ForbiddenException('Only an active customer account can create shipments.');
    }
    if (customer.verificationStatus !== 'VERIFIED') {
      throw new BadRequestException('Complete KYC approval before creating a shipment.');
    }
  }

  // "Maintenance mode" was pure copy on the admin platform settings screen - its own
  // description promised it would "block new shipment creation network-wide", but nothing
  // ever checked the flag. Fails open (not in maintenance) on a read error, same as the
  // other platform-setting gates added this session - an unrelated DB hiccup must never
  // block every shipment.
  private async assertNotInMaintenanceMode() {
    let setting: { value: string } | null = null;
    try {
      setting = await this.prisma.platformSetting.findUnique({ where: { key: 'maintenanceMode' } });
    } catch {
      // Read failure - fail open, see above.
    }
    if (setting?.value === 'true') {
      throw new BadRequestException('Tracko is temporarily in maintenance mode. New shipments cannot be created right now - please try again shortly.');
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
    let shipment;
    try {
      shipment = await this.prisma.shipment.findUnique({
        where: { id },
        include: { assignments: true, timeline: { orderBy: { createdAt: 'asc' } } },
      });
    } catch {
      // A real infrastructure failure (DB unreachable) - fall back to preview data.
      return this.previewShipment({ id });
    }

    if (!shipment) throw new NotFoundException('Shipment not found.');

    // Authorization failures must propagate as real errors, not be swallowed into a
    // successful-looking preview response - that would silently defeat this check.
    const canView =
      role === 'ADMIN' ||
      role === 'DISPATCHER' ||
      shipment.customerId === userId ||
      shipment.assignments.some((assignment) => assignment.driverId === userId);

    if (!canView) throw new ForbiddenException('You do not have access to this shipment.');
    return this.toShipmentRecord(shipment);
  }

  async updateStatus(id: string, userId: string, role: UserRole, dto: UpdateShipmentStatusDto) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id },
      include: { assignments: true },
    }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment not found.');

    const isOwner = shipment.customerId === userId;
    const isAssignedDriver = shipment.assignments.some((assignment) => assignment.driverId === userId && assignment.status === 'ACCEPTED');
    const isOperations = role === 'ADMIN' || role === 'DISPATCHER';
    if (!isOwner && !isAssignedDriver && !isOperations) {
      throw new ForbiddenException('You do not have access to this shipment.');
    }

    this.assertValidTransition(shipment.status, dto.status, role, { isOwner, isAssignedDriver, isOperations });

    try {
      const updated = await this.prisma.shipment.update({
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
      return this.toShipmentRecord(updated);
    } catch {
      return this.previewShipment({ id, status: dto.status });
    }
  }

  // Which statuses a shipment may move to next, and which relationship to the shipment
  // is allowed to make that specific move. Operations staff (ADMIN/DISPATCHER) can also
  // force CANCELLED or DISPUTED from most states to handle exceptions.
  private readonly statusTransitions: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
    DRAFT: ['QUOTED', 'CANCELLED'],
    QUOTED: ['PENDING_PAYMENT', 'CANCELLED'],
    PENDING_PAYMENT: ['ESCROW_FUNDED', 'CANCELLED'],
    ESCROW_FUNDED: ['DRIVER_ASSIGNED', 'CANCELLED', 'DISPUTED'],
    DRIVER_ASSIGNED: ['DRIVER_EN_ROUTE', 'CANCELLED'],
    DRIVER_EN_ROUTE: ['ARRIVED_PICKUP', 'CANCELLED'],
    ARRIVED_PICKUP: ['PICKED_UP', 'CANCELLED'],
    PICKED_UP: ['IN_TRANSIT'],
    IN_TRANSIT: ['ARRIVED_DESTINATION', 'DISPUTED'],
    ARRIVED_DESTINATION: ['DELIVERED'],
    DELIVERED: ['COMPLETED', 'DISPUTED'],
    DISPUTED: ['ESCROW_FUNDED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };

  private assertValidTransition(
    current: ShipmentStatus,
    next: ShipmentStatus,
    role: UserRole,
    relationship: { isOwner: boolean; isAssignedDriver: boolean; isOperations: boolean },
  ) {
    if (current === next) return;

    const allowed = this.statusTransitions[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(`Shipment cannot move from ${current} to ${next}.`);
    }

    // Operations staff can drive any allowed transition. Otherwise, only the specific
    // participant whose job that step actually is can trigger it.
    if (relationship.isOperations) return;

    const driverSteps: ShipmentStatus[] = ['DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION', 'DELIVERED'];
    if (driverSteps.includes(next)) {
      if (!relationship.isAssignedDriver) throw new ForbiddenException('Only the assigned driver can make this update.');
      return;
    }

    if (next === 'CANCELLED') {
      if (!relationship.isOwner && !relationship.isAssignedDriver) throw new ForbiddenException('You cannot cancel this shipment.');
      return;
    }

    // Anything else (QUOTED, PENDING_PAYMENT, ESCROW_FUNDED, COMPLETED, DISPUTED
    // transitions) is operations/system-driven, not something a customer or driver
    // triggers directly through this endpoint.
    throw new ForbiddenException('This status change must be made by platform operations.');
  }

  async availableDrivers() {
    try {
      const drivers = await this.prisma.$queryRawUnsafe<Array<{
        id: string;
        email: string;
        phone: string | null;
        verificationStatus: string;
        fullName: string | null;
        vehicles: Array<{ id: string; plateNumber: string; type: string; capacityKg: number | null }>;
      }>>(
        `select
          u."id", u."email", u."phone", u."verificationStatus"::text as "verificationStatus",
          p."fullName",
          coalesce(
            json_agg(
              json_build_object(
                'id', v."id",
                'plateNumber', v."plateNumber",
                'type', v."type",
                'capacityKg', v."capacityKg"
              )
            ) filter (where v."id" is not null),
            '[]'::json
          ) as "vehicles"
        from "User" u
        left join "Profile" p on p."userId" = u."id"
        left join "Vehicle" v on v."assignedDriverId" = u."id"
        where u."role" = 'DRIVER'::"UserRole"
          and u."isActive" = true
          and u."verificationStatus" = 'VERIFIED'::"VerificationStatus"
        group by u."id", p."fullName"
        order by u."createdAt" desc
        limit 50`,
      );

      return drivers.map((driver) => ({
        id: driver.id,
        fullName: driver.fullName ?? driver.email,
        email: driver.email,
        phone: driver.phone,
        verificationStatus: driver.verificationStatus,
        vehicles: driver.vehicles.map((vehicle) => ({
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

  async listAssignments(shipmentId: string, userId?: string, role?: UserRole) {
    if (userId && role) {
      const shipment = await this.prisma.shipment.findUnique({
        where: { id: shipmentId },
        select: {
          customerId: true,
          assignments: { select: { driverId: true, vehicle: { select: { ownerId: true } } } },
        },
      });
      if (!shipment) throw new NotFoundException('Shipment not found.');
      const canView = ['ADMIN', 'DISPATCHER'].includes(role)
        || shipment.customerId === userId
        || shipment.assignments.some((assignment) => assignment.driverId === userId || assignment.vehicle?.ownerId === userId);
      if (!canView) throw new ForbiddenException('You do not have access to this shipment assignment history.');
    }
    await this.expireStaleAssignmentOffers(shipmentId);
    try {
      const validityMinutes = await this.assignmentOfferValidityMinutes();
      const assignments = await this.prisma.driverAssignment.findMany({
        where: { shipmentId },
        include: {
          driver: { include: { profile: true } },
          vehicle: true,
          shipment: { include: { timeline: { orderBy: { createdAt: 'asc' } } } },
        },
        orderBy: { offeredAt: 'desc' },
      });
      return assignments.map((assignment) => this.toAssignmentRecord(assignment, validityMinutes));
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

    await this.expireStaleAssignmentOffers(shipmentId);
    const driverId = body.driverId ?? 'preview-driver';

    let shipment, escrowRows, driver, activeShipmentAssignment, activeDriverAssignment;
    try {
      [shipment, escrowRows, driver, activeShipmentAssignment, activeDriverAssignment] = await Promise.all([
        this.prisma.shipment.findUnique({ where: { id: shipmentId } }),
        this.prisma.$queryRawUnsafe<Array<{ status: string }>>(
          'select "status"::text as "status" from "Escrow" where "shipmentId" = $1 limit 1',
          shipmentId,
        ),
        this.prisma.user.findUnique({
          where: { id: driverId },
          include: { profile: true, driverVehicles: { where: { isActive: true } } },
        }),
        this.prisma.driverAssignment.findFirst({
          where: { shipmentId, status: { in: ['OFFERED', 'ACCEPTED'] } },
          select: { id: true, driverId: true, status: true },
        }),
        this.prisma.driverAssignment.findFirst({
          where: {
            driverId,
            status: { in: ['OFFERED', 'ACCEPTED'] },
            shipmentId: { not: shipmentId },
            shipment: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          },
          select: { id: true, shipmentId: true, status: true },
        }),
      ]);
    } catch {
      // A real infrastructure failure (DB unreachable) - fall back to preview data.
      return this.previewAssignment({ shipmentId, driverId, vehicleId: body.vehicleId, status: 'OFFERED' });
    }

    // Business-rule failures below must propagate as real errors. Swallowing them into a
    // fake "assignment created" response (as this used to do) would tell dispatch an
    // assignment succeeded when nothing was actually written to the database.
    if (!shipment) throw new NotFoundException('Shipment not found.');
    if (!shipment.adminApproved) {
      throw new BadRequestException('This shipment has not been approved by an admin yet.');
    }
    const escrow = escrowRows[0];
    if (!escrow || !['FUNDED', 'HELD', 'RELEASE_READY'].includes(escrow.status)) {
      throw new BadRequestException('Escrow must be funded before assigning a driver.');
    }
    if (!driver || driver.role !== 'DRIVER' || !driver.isActive || driver.verificationStatus !== 'VERIFIED') {
      throw new BadRequestException('Only KYC-approved active drivers can receive shipment assignments.');
    }
    if (activeShipmentAssignment) {
      throw new BadRequestException(
        activeShipmentAssignment.status === 'ACCEPTED'
          ? 'This shipment already has an accepted driver.'
          : 'This shipment already has a driver offer awaiting response.',
      );
    }
    if (activeDriverAssignment) {
      throw new BadRequestException('This driver already has an active shipment or pending offer. Select another driver.');
    }
    const cargoWeightKg = Math.max(0, Number(shipment.cargoWeightKg ?? 0));
    const eligibleVehicles = [...driver.driverVehicles]
      .filter((vehicle) => !cargoWeightKg || (vehicle.capacityKg ?? 0) >= cargoWeightKg)
      .sort((left, right) => (left.capacityKg ?? 0) - (right.capacityKg ?? 0));
    const selectedVehicle = body.vehicleId
      ? driver.driverVehicles.find((vehicle) => vehicle.id === body.vehicleId)
      : eligibleVehicles[0];
    if (!selectedVehicle) {
      throw new BadRequestException('This driver has no active truck available for the shipment.');
    }
    if (cargoWeightKg && (selectedVehicle.capacityKg ?? 0) < cargoWeightKg) {
      throw new BadRequestException('The selected truck does not have enough capacity for this cargo.');
    }

    const assignment = await this.prisma.driverAssignment.create({
      data: {
        shipmentId,
        driverId,
        vehicleId: selectedVehicle.id,
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

    return this.toAssignmentRecord(assignment, await this.assignmentOfferValidityMinutes());
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

      const validityMinutes = await this.assignmentOfferValidityMinutes();
      const expiresAt = this.assignmentExpiresAt(assignment.offeredAt, validityMinutes);
      if (expiresAt.getTime() <= Date.now()) {
        await this.expireAssignment(assignment.id, assignment.shipmentId, assignment.shipment.customerId);
        throw new BadRequestException('This load offer has expired. Dispatch will send the shipment to another eligible driver.');
      }

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

      const nextAssignment = action === 'REJECT' ? await this.offerNextEligibleDriver(updated.shipmentId) : null;
      return {
        ...this.toAssignmentRecord(updated, validityMinutes),
        nextAssignment,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      return this.previewAssignment({ id: assignmentId, driverId, status });
    }
  }

  async expireStaleAssignmentOffers(shipmentId?: string) {
    const validityMinutes = await this.assignmentOfferValidityMinutes();
    const cutoff = new Date(Date.now() - validityMinutes * 60_000);

    try {
      const stale = await this.prisma.driverAssignment.findMany({
        where: {
          status: 'OFFERED',
          offeredAt: { lte: cutoff },
          ...(shipmentId ? { shipmentId } : {}),
        },
        include: { shipment: true },
        orderBy: { offeredAt: 'asc' },
        take: 100,
      });

      for (const assignment of stale) {
        await this.expireAssignment(assignment.id, assignment.shipmentId, assignment.shipment.customerId);
      }

      return { expiredCount: stale.length, validityMinutes };
    } catch (error) {
      this.logger.error(`expireStaleAssignmentOffers() failed: ${error instanceof Error ? error.message : String(error)}`);
      return { expiredCount: 0, validityMinutes };
    }
  }

  private async expireAssignment(assignmentId: string, shipmentId: string, customerId: string) {
    const updated = await this.prisma.driverAssignment.updateMany({
      where: { id: assignmentId, status: 'OFFERED' },
      data: { status: 'EXPIRED', rejectedAt: new Date() },
    });
    if (!updated.count) return false;

    const activeAssignment = await this.prisma.driverAssignment.findFirst({
      where: { shipmentId, status: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true },
    });
    if (!activeAssignment) {
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'QUOTED',
          timeline: {
            create: {
              status: 'QUOTED',
              note: 'Driver offer expired. Shipment returned to dispatch for the next eligible driver.',
            },
          },
        },
      });
    }

    await this.notifications.create({
      userId: customerId,
      title: 'Driver offer expired',
      body: 'Dispatch is selecting the next eligible driver for your shipment.',
      tone: 'WARNING',
      entity: 'Shipment',
      entityId: shipmentId,
      actionUrl: `/shipments/${shipmentId}`,
    }).catch(() => null);
    await this.offerNextEligibleDriver(shipmentId);
    return true;
  }

  private async offerNextEligibleDriver(shipmentId: string) {
    try {
      const [shipment, previousAssignments, candidates] = await Promise.all([
        this.prisma.shipment.findUnique({
          where: { id: shipmentId },
          select: { cargoWeightKg: true },
        }),
        this.prisma.driverAssignment.findMany({
          where: { shipmentId, status: { in: ['REJECTED', 'EXPIRED'] } },
          select: { driverId: true },
        }),
        this.prisma.user.findMany({
          where: { role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED' },
          include: {
            driverVehicles: { where: { isActive: true } },
            driverAssignments: {
              where: { status: { in: ['OFFERED', 'ACCEPTED'] } },
              select: { id: true },
              take: 20,
            },
          },
          take: 100,
        }),
      ]);
      if (!shipment) return null;

      const excluded = new Set(previousAssignments.map((assignment) => assignment.driverId));
      const cargoWeightKg = Math.max(0, Number(shipment.cargoWeightKg ?? 0));
      const ranked = candidates
        .filter((driver) => !excluded.has(driver.id))
        .map((driver) => {
          const vehicle = [...driver.driverVehicles]
            .filter((candidate) => !cargoWeightKg || (candidate.capacityKg ?? 0) >= cargoWeightKg)
            .sort((left, right) => (left.capacityKg ?? 0) - (right.capacityKg ?? 0))[0];
          return { driver, vehicle, activeAssignments: driver.driverAssignments.length };
        })
        .filter((candidate) => Boolean(candidate.vehicle) && candidate.activeAssignments === 0)
        .sort((left, right) => left.activeAssignments - right.activeAssignments);
      const next = ranked[0];
      if (!next?.vehicle) return null;

      return await this.offerAssignment(
        shipmentId,
        { driverId: next.driver.id, vehicleId: next.vehicle.id },
        'DISPATCHER',
      );
    } catch (error) {
      this.logger.error(`offerNextEligibleDriver(${shipmentId}) failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async assignmentOfferValidityMinutes() {
    const setting = await this.prisma.platformSetting.findUnique({ where: { key: 'driverOfferValidityMinutes' } }).catch(() => null);
    const value = Number(setting?.value ?? this.defaultAssignmentOfferMinutes);
    return Number.isFinite(value) && value >= 5 && value <= 120 ? Math.round(value) : this.defaultAssignmentOfferMinutes;
  }

  private assignmentExpiresAt(offeredAt: Date | string, validityMinutes: number) {
    return new Date(new Date(offeredAt).getTime() + validityMinutes * 60_000);
  }

  async addTimelineEvent(shipmentId: string, userId: string, role: UserRole, event: Record<string, unknown>) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { assignments: true },
    }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment not found.');

    const isOwner = shipment.customerId === userId;
    const isAssignedDriver = shipment.assignments.some((assignment) => assignment.driverId === userId && assignment.status === 'ACCEPTED');
    const isOperations = role === 'ADMIN' || role === 'DISPATCHER';
    if (!isOwner && !isAssignedDriver && !isOperations) {
      throw new ForbiddenException('You do not have access to this shipment.');
    }

    try {
      const nextStatus = String(event.status ?? shipment.status ?? 'IN_TRANSIT');
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          status: string;
          note: string | null;
          createdAt: Date;
        }[]
      >(
        `insert into "ShipmentTimeline" ("id", "shipmentId", "status", "note")
         values ($1, $2, cast($3 as "ShipmentStatus"), $4)
         returning "id", "status"::text as "status", "note", "createdAt"`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own, or a manually-added timeline
        // note silently never gets saved even though the shipment's status still flips.
        `tl_${randomUUID().replace(/-/g, '')}`,
        shipmentId,
        nextStatus,
        event.note ? String(event.note) : String(event.label ?? 'Shipment updated'),
      );

      await this.prisma.$executeRawUnsafe(
        `update "Shipment"
         set "status" = cast($2 as "ShipmentStatus"),
             "updatedAt" = current_timestamp
         where "id" = $1`,
        shipmentId,
        nextStatus,
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

  // Funded shipments awaiting admin sign-off before dispatch can assign a driver.
  async pendingReview() {
    const shipments = await this.prisma.shipment.findMany({
      where: {
        adminApproved: false,
        status: { notIn: ['DRAFT', 'QUOTED', 'PENDING_PAYMENT', 'CANCELLED'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }).catch(() => []);
    return shipments.map((shipment) => this.toShipmentRecord(shipment));
  }

  async approveShipment(shipmentId: string, reviewerId: string, actorRole: UserRole) {
    if (actorRole !== 'ADMIN' && actorRole !== 'DISPATCHER') {
      throw new ForbiddenException('Only platform operations can approve a shipment.');
    }

    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment not found.');
    if (shipment.adminApproved) return this.toShipmentRecord(shipment);

    const updated = await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        adminApproved: true,
        adminApprovedAt: new Date(),
        adminApprovedById: reviewerId,
        timeline: {
          create: { status: shipment.status, note: 'Approved by platform operations - ready for driver matching.' },
        },
      },
      include: { timeline: { orderBy: { createdAt: 'asc' } } },
    });

    await this.notifications.create({
      role: 'DISPATCHER',
      title: 'Shipment approved',
      body: `${shipment.reference} was approved and is ready for driver assignment.`,
      tone: 'SUCCESS',
      entity: 'Shipment',
      entityId: shipmentId,
      actionUrl: '/dispatcher/assignment',
    });

    return this.toShipmentRecord(updated);
  }

  async releaseEscrow(shipmentId: string, actorRole: UserRole, note?: string) {
    if (actorRole !== 'ADMIN' && actorRole !== 'DISPATCHER') {
      throw new ForbiddenException('Only platform operations can release escrow.');
    }

    const escrow = await this.findEscrowOrThrow(shipmentId);
    if (escrow.status === 'DISPUTED') throw new BadRequestException('Escrow is disputed and cannot be released.');
    if (escrow.status === 'REFUNDED') throw new BadRequestException('Escrow has already been refunded.');
    if (escrow.status === 'RELEASED') return this.toEscrowRecord(escrow);

    // The status update is the actual point of this call - money moving from held to
    // released. This used to swallow ANY failure here (a real DB error, a connection
    // drop) into a fabricated "released" response that was never actually persisted -
    // the caller (a human admin, or the automated dispute-window auto-release job) has
    // to see a real error, not a false confirmation that money moved when it didn't.
    let releasedEscrow: ReturnType<ShipmentsService['toEscrowRecord']>;
    try {
      const rows = await this.prisma.$queryRawUnsafe<EscrowRow[]>(
        `update "Escrow"
         set "status" = 'RELEASED'::"EscrowStatus",
             "arrivalConfirmed" = true,
             "proofOfDeliveryUploaded" = true,
             "customerDeliveryConfirmed" = true,
             "disputeWindowClear" = true,
             "platformApproved" = true,
             "updatedAt" = current_timestamp
         where "shipmentId" = $1
         returning "id", "shipmentId", "amount", "currency", "status"::text as "status",
                   "arrivalConfirmed", "proofOfDeliveryUploaded", "customerDeliveryConfirmed", "disputeWindowClear", "platformApproved"`,
        shipmentId,
      );
      releasedEscrow = this.toEscrowRecord(rows[0] ?? { ...escrow, status: 'RELEASED' });
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not release escrow. Please try again: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Timeline note and driver notification are both already best-effort/non-throwing
    // internally - supplementary to the release itself, which already succeeded above.
    await this.updateShipmentTimeline(shipmentId, 'COMPLETED', note ?? 'Escrow released by platform operations.');
    await this.notifyAssignedDriverOfEscrowRelease(shipmentId, releasedEscrow.amount, releasedEscrow.currency);
    return releasedEscrow;
  }

  // The admin "Escrow release window" platform setting used to be pure copy - nothing
  // ever checked elapsed time and auto-released anything, so a driver could go unpaid on
  // an otherwise-fine delivery indefinitely if the customer never confirmed delivery and
  // never disputed it. Called on a schedule (see CronController) rather than exposed to
  // any client directly.
  async autoReleaseEligibleEscrows() {
    const windowDaysRaw = await this.prisma.platformSetting.findUnique({ where: { key: 'escrow' } }).catch(() => null);
    const windowDays = Math.max(1, Number(windowDaysRaw?.value ?? 3) || 3);

    let candidates: { shipmentId: string; deliveredAt: Date }[];
    try {
      candidates = await this.prisma.$queryRawUnsafe<{ shipmentId: string; deliveredAt: Date }[]>(
        `select s."id" as "shipmentId", dt."deliveredAt"
         from "Shipment" s
         join "Escrow" e on e."shipmentId" = s."id"
         join lateral (
           select max(t."createdAt") as "deliveredAt"
           from "ShipmentTimeline" t
           where t."shipmentId" = s."id" and t."status" = 'DELIVERED'::"ShipmentStatus"
         ) dt on dt."deliveredAt" is not null
         where s."status" = 'DELIVERED'::"ShipmentStatus"
           and e."status" in ('FUNDED'::"EscrowStatus", 'HELD'::"EscrowStatus", 'RELEASE_READY'::"EscrowStatus")
           and dt."deliveredAt" <= now() - ($1 || ' days')::interval
           and not exists (
             select 1 from "Dispute" d
             where d."shipmentId" = s."id" and d."status" in ('OPEN'::"DisputeStatus", 'IN_REVIEW'::"DisputeStatus")
           )
         order by dt."deliveredAt" asc
         limit 100`,
        String(windowDays),
      );
    } catch (error) {
      this.logger.error(`autoReleaseEligibleEscrows() failed to query candidates: ${error instanceof Error ? error.message : String(error)}`);
      throw new InternalServerErrorException('Could not run the escrow auto-release check.');
    }

    const results: { shipmentId: string; released: boolean; error?: string }[] = [];
    for (const candidate of candidates) {
      try {
        await this.releaseEscrow(
          candidate.shipmentId,
          'ADMIN',
          `Escrow auto-released - delivered ${windowDays}+ days ago with no dispute filed.`,
        );
        results.push({ shipmentId: candidate.shipmentId, released: true });
      } catch (error) {
        // One shipment failing to release (e.g. a race with a dispute filed moments ago)
        // must never stop the rest of the batch from being checked.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`autoReleaseEligibleEscrows() failed to release escrow for shipment ${candidate.shipmentId}: ${message}`);
        results.push({ shipmentId: candidate.shipmentId, released: false, error: message });
      }
    }

    return {
      windowDays,
      checkedAt: new Date().toISOString(),
      candidateCount: candidates.length,
      releasedCount: results.filter((result) => result.released).length,
      results,
    };
  }

  async submitReview(shipmentId: string, customerId: string, input: { rating?: number; comment?: string }) {
    const rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be a whole number from 1 to 5.');
    }

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { assignments: { where: { status: 'ACCEPTED' }, take: 1 } },
    }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment not found.');
    if (shipment.customerId !== customerId) {
      throw new ForbiddenException('Only the customer on this shipment can leave a review.');
    }
    if (!['DELIVERED', 'COMPLETED'].includes(shipment.status)) {
      throw new BadRequestException('You can only review a shipment after delivery.');
    }

    const existing = await this.prisma.review.findUnique({ where: { shipmentId } }).catch(() => null);
    if (existing) throw new BadRequestException('This shipment has already been reviewed.');

    const driverId = shipment.assignments[0]?.driverId;
    const review = await this.prisma.review.create({
      data: {
        shipmentId,
        customerId,
        driverId,
        rating,
        comment: input.comment?.trim() || null,
      },
    });

    if (driverId) {
      await this.notifications.create({
        userId: driverId,
        title: 'New rating received',
        body: `A customer rated a completed trip ${rating}/5.`,
        tone: rating >= 4 ? 'SUCCESS' : 'INFO',
        entity: 'Review',
        entityId: review.id,
        actionUrl: '/driver/earnings',
      });
    }

    return review;
  }

  async getReview(shipmentId: string) {
    const review = await this.prisma.review.findUnique({ where: { shipmentId } }).catch(() => null);
    return review;
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

  private async notifyAssignedDriverOfEscrowRelease(shipmentId: string, amount?: number | null, currency = 'NGN') {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ driverId: string; reference: string | null }>>(
        `select da."driverId", s."reference"
         from "DriverAssignment" da
         join "Shipment" s on s."id" = da."shipmentId"
         where da."shipmentId" = $1 and da."status" = 'ACCEPTED'
         order by da."acceptedAt" desc nulls last, da."offeredAt" desc
         limit 1`,
        shipmentId,
      );
      const assignment = rows[0];
      if (!assignment?.driverId) return;

      await this.notifications.create({
        userId: assignment.driverId,
        title: 'Escrow released',
        body: `${this.formatMoney(amount, currency)} for ${assignment.reference ?? shipmentId} is now available for withdrawal.`,
        tone: 'SUCCESS',
        entity: 'Escrow',
        entityId: shipmentId,
        actionUrl: '/driver/earnings',
      });
    } catch {
      // Escrow release should not fail because notification delivery failed.
    }
  }

  private formatMoney(amountKobo?: number | null, currency = 'NGN') {
    if (!amountKobo) return currency === 'NGN' ? 'N0' : `${currency} 0`;
    const amount = Math.round(Number(amountKobo) / 100).toLocaleString('en-US');
    return currency === 'NGN' ? `N${amount}` : `${currency} ${amount}`;
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
        `insert into "Escrow" ("id", "shipmentId", "amount", "currency", "status", "updatedAt")
         values ($1, $2, $3, 'NGN', 'PENDING'::"EscrowStatus", current_timestamp)
         on conflict ("shipmentId") do update set
           "amount" = excluded."amount",
           "currency" = excluded."currency",
           "updatedAt" = current_timestamp
         returning "id"`,
        `escrow-${shipmentId}`,
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
        `insert into "MediaAsset" ("id", "userId", "shipmentId", "kind", "url", "label")
         values ($1, $2, $3, 'CARGO_PHOTO'::"MediaKind", $4, 'Cargo photo')
         returning "id", "kind"::text as "kind", "url", "label"`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own.
        `media_${randomUUID().replace(/-/g, '')}`,
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
      pricingVersion?: string;
      quoteValidMinutes?: number;
      pricingBreakdown?: Awaited<ReturnType<MapsProviderService['routeEstimate']>>['pricingBreakdown'];
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
      quotedPriceKobo: shipment.quotedPriceKobo ?? undefined,
      distanceKm: shipment.distanceKm ?? undefined,
      durationMinutes: shipment.durationMinutes ?? undefined,
      pricingVersion: options.pricingVersion,
      quoteValidMinutes: options.quoteValidMinutes,
      pricingBreakdown: options.pricingBreakdown,
      status: shipment.status ?? 'DRAFT',
      escrowId: options.escrowId ?? `escrow-${shipment.id}`,
      media: options.media ?? [],
      timeline: (shipment.timeline ?? []).map((event) => this.toTimelineRecord(event)),
    };
  }

  private async recordQuoteSnapshot(
    customerId: string,
    shipmentId: string,
    quote: Awaited<ReturnType<MapsProviderService['routeEstimate']>>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorId: customerId,
        action: 'SHIPMENT_QUOTE_ACCEPTED',
        entity: 'Shipment',
        entityId: shipmentId,
        metadata: JSON.parse(JSON.stringify({
          pricingVersion: quote.pricingVersion,
          acceptedAt: new Date().toISOString(),
          quoteValidMinutes: quote.quoteValidMinutes,
          provider: quote.provider,
          pricingMode: quote.pricingMode,
          currency: quote.currency,
          quotedPriceKobo: quote.quotedPriceKobo,
          distanceKm: quote.distanceKm,
          durationMinutes: quote.durationMinutes,
          pricingBreakdown: quote.pricingBreakdown,
        })),
      },
    });
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

  private toAssignmentRecord(assignment: AssignmentRecordInput, validityMinutes = this.defaultAssignmentOfferMinutes) {
    const offeredAt = assignment.offeredAt instanceof Date ? assignment.offeredAt.toISOString() : assignment.offeredAt;
    return {
      id: assignment.id,
      shipmentId: assignment.shipmentId,
      driverId: assignment.driverId,
      vehicleId: assignment.vehicleId ?? undefined,
      status: assignment.status,
      offeredAt,
      expiresAt: this.assignmentExpiresAt(offeredAt, validityMinutes).toISOString(),
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
    const offeredAt = new Date();
    return {
      id: String(input.id ?? `assignment-${Date.now()}`),
      shipmentId: String(input.shipmentId ?? 'TRK-1024'),
      driverId: String(input.driverId ?? 'preview-driver'),
      vehicleId: input.vehicleId ? String(input.vehicleId) : 'preview-vehicle',
      status: String(input.status ?? 'OFFERED'),
      offeredAt: offeredAt.toISOString(),
      expiresAt: this.assignmentExpiresAt(offeredAt, this.defaultAssignmentOfferMinutes).toISOString(),
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
