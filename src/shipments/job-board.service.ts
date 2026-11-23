import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isStoreReviewerAccount } from '../common/store-reviewer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ensureJobRequestTable, JobRequestRow } from './job-board-store';
import { distanceKm } from './return-load';
import { ShipmentsService } from './shipments.service';

// The job board (see job-board-store.ts for the rule). Drivers with no undelivered trip see
// every paid, approved load that has no driver yet and that one of their trucks can carry.
// They ask for a load; the customer (or operations for them) picks one driver, which locks
// the load to that driver as an accepted assignment and closes every other request.

const ON_TRIP_STATUSES = ['DELIVERED', 'COMPLETED', 'CANCELLED'] as const;
const FUNDED_ESCROW = ['FUNDED', 'HELD', 'RELEASE_READY'] as const;
/** A driver position older than this is not used for "km to pickup". */
const FRESH_POSITION_MS = 2 * 60 * 60 * 1000;

export type DriverBoardState = 'OPEN' | 'ON_TRIP' | 'OFFLINE' | 'NOT_VERIFIED' | 'NO_TRUCK';

@Injectable()
export class JobBoardService {
  private readonly logger = new Logger(JobBoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly notifications: NotificationsService,
  ) {
    this.shipments.onLoadPosted = (shipmentId) => this.announce(shipmentId);
  }

  /**
   * Tells every driver who could ask for this load right now (verified, online, no undelivered
   * trip, a ready truck it fits) that it is on the board. Called when an admin approves a load.
   */
  async announce(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { customer: { select: { email: true } } },
    });
    if (!shipment) return { notified: 0 };
    const drivers = await this.prisma.user.findMany({
      where: {
        role: 'DRIVER',
        isActive: true,
        verificationStatus: 'VERIFIED',
        driverAssignments: { none: { status: 'ACCEPTED', shipment: { status: { notIn: [...ON_TRIP_STATUSES] } } } },
      },
      include: {
        driverVehicles: {
          where: { isActive: true },
          include: { documents: { select: { type: true, state: true, expires: true } } },
        },
      },
      take: 200,
    });
    const offline = new Set((await this.prisma.$queryRawUnsafe<Array<{ userId: string }>>(
      `select "userId" from "SafetySettings" where "availableForAssignments" = false`,
    ).catch(() => [])).map((row) => row.userId));
    const sandboxLoad = isStoreReviewerAccount(shipment.customer?.email);
    const eligible = drivers.filter((driver) =>
      !offline.has(driver.id)
      && isStoreReviewerAccount(driver.email) === sandboxLoad
      && driver.driverVehicles.some((truck) => this.shipments.isVehicleAssignmentReady(truck) && this.truckFits(truck, shipment)),
    );
    for (const driver of eligible) {
      await this.notifications.create({
        userId: driver.id,
        role: 'DRIVER',
        title: 'New load on the job board',
        body: `${shipment.pickupLabel} to ${shipment.destinationLabel}. Ask for it in Jobs; the customer chooses the driver.`,
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: '/driver/jobs',
        preferenceKey: 'driverOffers',
      });
    }
    return { notified: eligible.length };
  }

  /** The loads this driver can ask for, nearest first, and why the board is closed if it is. */
  async listForDriver(driverId: string) {
    await ensureJobRequestTable(this.prisma);
    const [driver, availability, activeTrip] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: driverId },
        include: {
          driverVehicles: {
            where: { isActive: true },
            include: { documents: { select: { type: true, state: true, expires: true } } },
          },
        },
      }),
      this.availability(driverId),
      this.activeTrip(driverId),
    ]);
    if (!driver || driver.role !== 'DRIVER' || !driver.isActive || driver.verificationStatus !== 'VERIFIED') {
      return { state: 'NOT_VERIFIED' as DriverBoardState, loads: [] };
    }
    if (activeTrip) {
      return { state: 'ON_TRIP' as DriverBoardState, activeTrip: activeTrip.shipment.reference, loads: [] };
    }
    const trucks = driver.driverVehicles.filter((vehicle) => this.shipments.isVehicleAssignmentReady(vehicle));
    if (!trucks.length) return { state: 'NO_TRUCK' as DriverBoardState, loads: [] };

    const shipments = await this.prisma.shipment.findMany({
      where: {
        adminApproved: true,
        status: 'ESCROW_FUNDED',
        escrow: { is: { status: { in: [...FUNDED_ESCROW] } } },
        assignments: { none: { status: { in: ['OFFERED', 'ACCEPTED'] } } },
      },
      include: { customer: { select: { email: true } } },
      orderBy: { adminApprovedAt: 'asc' },
      take: 50,
    });
    const sandboxDriver = isStoreReviewerAccount(driver.email);
    const fits = shipments.filter((shipment) =>
      isStoreReviewerAccount(shipment.customer?.email) === sandboxDriver
      && trucks.some((truck) => this.truckFits(truck, shipment)),
    );
    const requests = await this.requestsFor(driverId, fits.map((shipment) => shipment.id));
    const position = this.freshPosition(availability);

    const loads = fits
      .filter((shipment) => requests.get(shipment.id)?.status !== 'DECLINED')
      .map((shipment) => {
        const pickupKm = position
          ? distanceKm(position.latitude, position.longitude, shipment.pickupLatitude, shipment.pickupLongitude)
          : null;
        const request = requests.get(shipment.id);
        return {
          shipmentDbId: shipment.id,
          shipmentId: shipment.reference,
          origin: shipment.pickupLabel,
          destination: shipment.destinationLabel,
          originCoordinates: this.coordinates(shipment.pickupLatitude, shipment.pickupLongitude),
          destinationCoordinates: this.coordinates(shipment.destinationLatitude, shipment.destinationLongitude),
          cargo: shipment.cargoDescription,
          cargoWeightKg: shipment.cargoWeightKg ?? null,
          quotedPriceKobo: shipment.quotedPriceKobo ?? null,
          routeKm: shipment.distanceKm ?? null,
          durationMinutes: shipment.durationMinutes ?? null,
          pickupKm: pickupKm === null ? null : Math.round(pickupKm * 10) / 10,
          postedAt: (shipment.adminApprovedAt ?? shipment.createdAt).toISOString(),
          requested: request?.status === 'PENDING',
        };
      })
      .sort((left, right) => (left.pickupKm ?? Number.POSITIVE_INFINITY) - (right.pickupKm ?? Number.POSITIVE_INFINITY));

    const state: DriverBoardState = availability?.availableForAssignments === false ? 'OFFLINE' : 'OPEN';
    return { state, loads };
  }

  /** A driver asks for a load on the board. Asking again for the same load is harmless. */
  async request(driverId: string, shipmentRef: string) {
    await ensureJobRequestTable(this.prisma);
    const shipment = await this.findShipment(shipmentRef);
    const activeTrip = await this.activeTrip(driverId);
    if (activeTrip) {
      throw new BadRequestException(`Mark ${activeTrip.shipment.reference} delivered before asking for another load.`);
    }
    const [driver, customer] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: driverId }, include: { profile: true } }),
      this.prisma.user.findUnique({ where: { id: shipment.customerId }, select: { email: true } }),
    ]);
    if (!driver || isStoreReviewerAccount(driver.email) !== isStoreReviewerAccount(customer?.email)) {
      throw new NotFoundException('This load is no longer on the job board.');
    }
    // Same rules as a dispatch offer: approved, funded, no driver yet, driver online, truck fits.
    const { vehicle } = await this.shipments.checkAssignmentEligibility(shipment.id, driverId);

    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `insert into "JobRequest" ("id", "shipmentId", "driverId", "vehicleId", "status")
       values ($1, $2, $3, $4, 'PENDING')
       on conflict ("shipmentId", "driverId") do update
         set "status" = 'PENDING', "vehicleId" = excluded."vehicleId", "createdAt" = current_timestamp, "decidedAt" = null
         where "JobRequest"."status" in ('WITHDRAWN', 'CLOSED')
       returning "id"`,
      `jobreq_${randomUUID().replace(/-/g, '')}`,
      shipment.id,
      driverId,
      vehicle.id,
    );
    if (!inserted[0]) {
      const existing = (await this.requestsFor(driverId, [shipment.id])).get(shipment.id);
      if (existing?.status === 'PENDING') return { requestId: existing.id, status: 'PENDING' as const };
      if (existing?.status === 'DECLINED') {
        throw new BadRequestException('The customer chose not to take your request for this load.');
      }
      throw new BadRequestException('This load is no longer on the job board.');
    }

    const driverName = this.driverName(driver);
    await this.notifications.create({
      userId: shipment.customerId,
      role: 'CUSTOMER',
      title: 'A driver wants to carry your load',
      body: `${driverName} asked to carry ${shipment.reference}. Open the shipment to see the driver and choose.`,
      tone: 'INFO',
      entity: 'Shipment',
      entityId: shipment.id,
      actionUrl: `/customer/shipment/${shipment.id}`,
      preferenceKey: 'driverOffers',
    });
    return { requestId: inserted[0].id, status: 'PENDING' as const };
  }

  async withdraw(driverId: string, shipmentRef: string) {
    await ensureJobRequestTable(this.prisma);
    const shipment = await this.findShipment(shipmentRef);
    await this.prisma.$executeRawUnsafe(
      `update "JobRequest" set "status" = 'WITHDRAWN', "decidedAt" = current_timestamp
       where "shipmentId" = $1 and "driverId" = $2 and "status" = 'PENDING'`,
      shipment.id,
      driverId,
    );
    return { status: 'WITHDRAWN' as const };
  }

  /** Drivers who asked for this load, for the customer who owns it and for operations. */
  async listForShipment(shipmentRef: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const shipment = await this.findShipment(shipmentRef);
    this.assertCanChoose(shipment, userId, role);

    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select "id", "shipmentId", "driverId", "vehicleId", "status", "createdAt", "decidedAt"
       from "JobRequest" where "shipmentId" = $1 order by "createdAt" asc`,
      shipment.id,
    );
    const openAssignment = await this.prisma.driverAssignment.findFirst({
      where: { shipmentId: shipment.id, status: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true },
    });
    const onBoard = !openAssignment && shipment.adminApproved && shipment.status === 'ESCROW_FUNDED';
    const pending = rows.filter((row) => row.status === 'PENDING');
    if (!pending.length) return { onBoard, requests: [] };

    const driverIds = pending.map((row) => row.driverId);
    const [drivers, busy, availability] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: driverIds } },
        include: {
          profile: true,
          driverVehicles: { where: { isActive: true }, select: { id: true, type: true, capacityKg: true } },
          driverReviews: { select: { rating: true }, take: 100 },
          driverAssignments: {
            where: { status: 'ACCEPTED', shipment: { status: 'COMPLETED' } },
            select: { id: true },
            take: 500,
          },
        },
      }),
      this.prisma.driverAssignment.findMany({
        where: {
          driverId: { in: driverIds },
          OR: [
            { status: 'ACCEPTED', shipment: { status: { notIn: [...ON_TRIP_STATUSES] } } },
            { status: 'OFFERED', shipmentId: { not: shipment.id } },
          ],
        },
        select: { driverId: true },
      }),
      this.prisma.$queryRawUnsafe<Array<{
        userId: string;
        availableForAssignments: boolean;
        lastKnownLatitude: number | null;
        lastKnownLongitude: number | null;
        locationUpdatedAt: Date | string | null;
      }>>(
        `select "userId", "availableForAssignments", "lastKnownLatitude", "lastKnownLongitude", "locationUpdatedAt"
         from "SafetySettings" where "userId" = any($1::text[])`,
        driverIds,
      ).catch(() => []),
    ]);
    const busyDrivers = new Set(busy.map((row) => row.driverId));
    const availabilityByDriver = new Map(availability.map((row) => [row.userId, row]));

    const requests = pending.flatMap((row) => {
      const driver = drivers.find((candidate) => candidate.id === row.driverId);
      if (!driver) return [];
      const truck = driver.driverVehicles.find((vehicle) => vehicle.id === row.vehicleId) ?? driver.driverVehicles[0];
      const reviews = driver.driverReviews ?? [];
      const rating = reviews.length ? reviews.reduce((total, review) => total + review.rating, 0) / reviews.length : null;
      const position = this.freshPosition(availabilityByDriver.get(driver.id));
      const pickupKm = position
        ? distanceKm(position.latitude, position.longitude, shipment.pickupLatitude, shipment.pickupLongitude)
        : null;
      const offline = availabilityByDriver.get(driver.id)?.availableForAssignments === false;
      return [{
        id: row.id,
        requestedAt: new Date(row.createdAt).toISOString(),
        driverName: this.driverName(driver),
        rating: rating === null ? null : Math.round(rating * 10) / 10,
        reviewCount: reviews.length,
        completedTrips: driver.driverAssignments.length,
        truckType: truck?.type ?? null,
        truckCapacityKg: truck?.capacityKg ?? null,
        pickupKm: pickupKm === null ? null : Math.round(pickupKm * 10) / 10,
        // A driver who took other work or went offline since asking can't be chosen now.
        available: !busyDrivers.has(driver.id) && !offline,
      }];
    });
    return { onBoard, requests };
  }

  /** The customer (or operations) picks a driver: the load becomes that driver's accepted job. */
  async approve(requestId: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const request = await this.findRequest(requestId);
    const shipment = await this.findShipment(request.shipmentId);
    this.assertCanChoose(shipment, userId, role);
    if (request.status !== 'PENDING') throw new BadRequestException('This driver request is no longer open.');

    const activeTrip = await this.activeTrip(request.driverId);
    if (activeTrip) throw new BadRequestException('This driver has started another trip and can no longer take this load.');
    // Re-checked now: the driver's KYC, truck documents and availability may have changed.
    const { vehicle } = await this.shipments.checkAssignmentEligibility(shipment.id, request.driverId);

    const claimed = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `update "JobRequest" set "status" = 'APPROVED', "decidedAt" = current_timestamp
       where "id" = $1 and "status" = 'PENDING' returning "id"`,
      requestId,
    );
    if (!claimed[0]) throw new BadRequestException('This driver request was already handled.');

    let assignmentId: string;
    try {
      const assignment = await this.prisma.driverAssignment.create({
        data: {
          shipmentId: shipment.id,
          driverId: request.driverId,
          vehicleId: vehicle.id,
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
        select: { id: true },
      });
      assignmentId = assignment.id;
    } catch (error) {
      await this.prisma.$executeRawUnsafe(
        `update "JobRequest" set "status" = 'PENDING', "decidedAt" = null where "id" = $1`,
        requestId,
      ).catch(() => undefined);
      // One open or accepted assignment per shipment (unique index): someone else won.
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException('Another driver was confirmed for this load a moment ago.');
      }
      throw error;
    }

    const chosenByCustomer = role === 'CUSTOMER';
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'DRIVER_EN_ROUTE',
        timeline: {
          create: {
            status: 'DRIVER_EN_ROUTE',
            note: chosenByCustomer
              ? 'Customer chose a driver from the job board.'
              : `${role === 'ADMIN' ? 'Admin' : 'Dispatch'} chose a driver from the job board for the customer.`,
          },
        },
      },
    });

    // Everyone else who asked for this load, and this driver's other open requests, are closed.
    const others = await this.prisma.$queryRawUnsafe<Array<{ driverId: string }>>(
      `update "JobRequest" set "status" = 'CLOSED', "decidedAt" = current_timestamp
       where "status" = 'PENDING' and ("shipmentId" = $1 or "driverId" = $2)
       returning "driverId", "shipmentId"`,
      shipment.id,
      request.driverId,
    ).catch((error: unknown) => {
      this.logger.warn(`Could not close other job requests for ${shipment.reference}: ${String(error)}`);
      return [];
    });

    await this.notifications.create({
      userId: request.driverId,
      role: 'DRIVER',
      title: 'You got the load',
      body: `The customer chose you for ${shipment.reference}. Head to the pickup when you are ready.`,
      tone: 'SUCCESS',
      entity: 'DriverAssignment',
      entityId: assignmentId,
      actionUrl: '/driver/trip',
      preferenceKey: 'driverOffers',
    });
    for (const other of others.filter((row) => row.driverId !== request.driverId)) {
      await this.notifications.create({
        userId: other.driverId,
        role: 'DRIVER',
        title: 'Load taken',
        body: `The customer chose another driver for ${shipment.reference}.`,
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: '/driver/jobs',
        preferenceKey: 'driverOffers',
      });
    }
    if (!chosenByCustomer) {
      await this.notifications.create({
        userId: shipment.customerId,
        role: 'CUSTOMER',
        title: 'Driver confirmed',
        body: `Trako operations confirmed a driver for ${shipment.reference}.`,
        tone: 'SUCCESS',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: `/customer/shipment/${shipment.id}`,
        preferenceKey: 'driverOffers',
      });
    }
    return { status: 'APPROVED' as const, assignmentId, shipmentId: shipment.id };
  }

  async decline(requestId: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const request = await this.findRequest(requestId);
    const shipment = await this.findShipment(request.shipmentId);
    this.assertCanChoose(shipment, userId, role);
    const declined = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `update "JobRequest" set "status" = 'DECLINED', "decidedAt" = current_timestamp
       where "id" = $1 and "status" = 'PENDING' returning "id"`,
      requestId,
    );
    if (!declined[0]) throw new BadRequestException('This driver request is no longer open.');
    await this.notifications.create({
      userId: request.driverId,
      role: 'DRIVER',
      title: 'Request not taken',
      body: `The customer chose not to take your request for ${shipment.reference}.`,
      tone: 'INFO',
      entity: 'Shipment',
      entityId: shipment.id,
      actionUrl: '/driver/jobs',
      preferenceKey: 'driverOffers',
    });
    return { status: 'DECLINED' as const };
  }

  private assertCanChoose(shipment: { customerId: string }, userId: string, role: UserRole) {
    if (role === 'ADMIN' || role === 'DISPATCHER') return;
    if (role === 'CUSTOMER' && shipment.customerId === userId) return;
    throw new ForbiddenException('Only the customer who booked this shipment can choose its driver.');
  }

  private async findShipment(idOrReference: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { OR: [{ id: idOrReference }, { reference: idOrReference }] },
    });
    if (!shipment) throw new NotFoundException('Shipment not found.');
    return shipment;
  }

  private async findRequest(requestId: string) {
    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select "id", "shipmentId", "driverId", "vehicleId", "status", "createdAt", "decidedAt"
       from "JobRequest" where "id" = $1 limit 1`,
      requestId,
    );
    if (!rows[0]) throw new NotFoundException('Driver request not found.');
    return rows[0];
  }

  private async requestsFor(driverId: string, shipmentIds: string[]) {
    if (!shipmentIds.length) return new Map<string, JobRequestRow>();
    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select "id", "shipmentId", "driverId", "vehicleId", "status", "createdAt", "decidedAt"
       from "JobRequest" where "driverId" = $1 and "shipmentId" = any($2::text[])`,
      driverId,
      shipmentIds,
    );
    return new Map(rows.map((row) => [row.shipmentId, row]));
  }

  /** The driver's accepted trip that is not delivered yet; while it exists the board is closed. */
  private activeTrip(driverId: string) {
    return this.prisma.driverAssignment.findFirst({
      where: { driverId, status: 'ACCEPTED', shipment: { status: { notIn: [...ON_TRIP_STATUSES] } } },
      select: { shipment: { select: { reference: true } } },
    });
  }

  private async availability(driverId: string) {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      availableForAssignments: boolean;
      lastKnownLatitude: number | null;
      lastKnownLongitude: number | null;
      locationUpdatedAt: Date | string | null;
    }>>(
      `select "availableForAssignments", "lastKnownLatitude", "lastKnownLongitude", "locationUpdatedAt"
       from "SafetySettings" where "userId" = $1 limit 1`,
      driverId,
    ).catch(() => []);
    return rows[0] ?? null;
  }

  private freshPosition(row: {
    lastKnownLatitude: number | null;
    lastKnownLongitude: number | null;
    locationUpdatedAt: Date | string | null;
  } | null | undefined) {
    if (!row || row.lastKnownLatitude == null || row.lastKnownLongitude == null || !row.locationUpdatedAt) return null;
    if (Date.now() - new Date(row.locationUpdatedAt).getTime() > FRESH_POSITION_MS) return null;
    return { latitude: row.lastKnownLatitude, longitude: row.lastKnownLongitude };
  }

  private truckFits(
    truck: { capacityKg: number | null; capacityM3: number | null },
    shipment: { cargoWeightKg: number | null; cargoVolumeM3: number | null },
  ) {
    const weight = Math.max(0, Number(shipment.cargoWeightKg ?? 0));
    const volume = Math.max(0, Number(shipment.cargoVolumeM3 ?? 0));
    return (!weight || (truck.capacityKg ?? 0) >= weight) && (!volume || (truck.capacityM3 ?? 0) >= volume);
  }

  private driverName(driver: { email: string; profile?: { fullName: string } | null }) {
    const fullName = driver.profile?.fullName?.trim();
    if (!fullName) return 'A Trako driver';
    // First name and last initial: enough to choose by, without the full name before booking.
    const [first, ...rest] = fullName.split(/\s+/);
    const last = rest.at(-1);
    return last ? `${first} ${last[0].toUpperCase()}.` : first;
  }

  private coordinates(latitude: number | null, longitude: number | null) {
    return latitude == null || longitude == null ? null : { latitude, longitude };
  }
}
