import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isStoreReviewerAccount } from '../common/store-reviewer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ensurePlatformFeeColumn } from '../integrations/platform-commission';
import {
  priceForCarrier,
  proposalBounds,
  ProposalBounds,
  QuoteParts,
  quotePartsFrom,
  RECENT_CHECKOUT_MINUTES,
} from './job-board-price';
import { ensureJobRequestTable, JOB_REQUEST_COLUMNS, jobBoardPriceRangePercent, JobRequestRow } from './job-board-store';
import { distanceKm } from './return-load';
import { ShipmentsService } from './shipments.service';

// The job board (see job-board-store.ts for the rule). Drivers with no undelivered trip see
// every load with no driver yet that one of their trucks can carry, nearest pickup first:
// paid and approved loads, paid loads still being checked by an admin, and (since 23 November
// 2026) booked loads the customer has not paid for yet. Drivers may ask for any of them, but
// the customer (or operations for them) can only choose a driver once the load is paid and
// approved, which locks it to that driver as an accepted assignment and closes every other
// request. So no truck moves before the money is held.

const ON_TRIP_STATUSES = ['DELIVERED', 'COMPLETED', 'CANCELLED'] as const;
const FUNDED_ESCROW = ['FUNDED', 'HELD', 'RELEASE_READY'] as const;
/** Booked but not paid yet. */
const UNPAID_STATUSES = ['DRAFT', 'QUOTED', 'PENDING_PAYMENT'] as const;
/** An unpaid booking older than this is treated as abandoned and left off the board. */
const UNPAID_BOARD_DAYS = 7;
/** A driver position older than this is not used for "km to pickup". */
const FRESH_POSITION_MS = 2 * 60 * 60 * 1000;

export type DriverBoardState = 'OPEN' | 'ON_TRIP' | 'OFFLINE' | 'NOT_VERIFIED' | 'NO_TRUCK';
/** READY: the customer can choose a driver now. The other two wait on the customer's payment or an admin. */
export type BoardLoadStatus = 'READY' | 'AWAITING_PAYMENT' | 'AWAITING_APPROVAL';
export type DriverPosition = { latitude: number; longitude: number };

export function boardStatusOf(shipment: { status: string; adminApproved: boolean }): BoardLoadStatus | null {
  if ((UNPAID_STATUSES as readonly string[]).includes(shipment.status)) return 'AWAITING_PAYMENT';
  if (shipment.status !== 'ESCROW_FUNDED') return null;
  return shipment.adminApproved ? 'READY' : 'AWAITING_APPROVAL';
}

@Injectable()
export class JobBoardService {
  private readonly logger = new Logger(JobBoardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
    private readonly notifications: NotificationsService,
  ) {
    this.shipments.onLoadPosted = (shipmentId) => this.announce(shipmentId);
    this.shipments.assignReservedDriver = (shipmentId) => this.assignReserved(shipmentId);
  }

  /**
   * Called when an admin approves a paid load. If the customer accepted a driver's price before
   * paying, that driver gets the load now (true). If they can no longer take it, the hold is
   * dropped, both sides are told, and the load goes on the board as usual (false).
   */
  async assignReserved(shipmentId: string) {
    await ensureJobRequestTable(this.prisma);
    const request = await this.reservedRequest(shipmentId);
    if (!request) return false;
    const shipment = await this.findShipment(shipmentId);
    try {
      await this.assignRequest(request, shipment, 'SYSTEM');
      return true;
    } catch (error) {
      this.logger.warn(`Held driver for ${shipment.reference} could not take it: ${error instanceof Error ? error.message : String(error)}`);
      await this.prisma.$executeRawUnsafe(
        `update "JobRequest" set "status" = 'CLOSED', "decidedAt" = current_timestamp where "id" = $1 and "status" = 'PENDING'`,
        request.id,
      );
      await this.notifications.create({
        userId: request.driverId,
        role: 'DRIVER',
        title: 'Load released',
        body: `You could not be given ${shipment.reference} (for example a truck document or another trip), so it went back on the job board.`,
        tone: 'WARNING',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: '/driver/jobs',
        preferenceKey: 'driverOffers',
      });
      await this.notifications.create({
        userId: shipment.customerId,
        role: 'CUSTOMER',
        title: 'Finding you another driver',
        body: `The driver whose price you accepted can no longer take ${shipment.reference}. You keep the price you paid, and other drivers can now ask for the load.`,
        tone: 'WARNING',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: `/customer/shipment/${shipment.id}`,
        preferenceKey: 'driverOffers',
      });
      return false;
    }
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

  /**
   * The loads this driver can ask for, nearest first, and why the board is closed if it is.
   * `near` is the phone's current position (sent by the Jobs screen); without it the driver's
   * last trip position is used when it is recent.
   */
  async listForDriver(driverId: string, near?: DriverPosition | null) {
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
        assignments: { none: { status: { in: ['OFFERED', 'ACCEPTED'] } } },
        OR: [
          { status: 'ESCROW_FUNDED', escrow: { is: { status: { in: [...FUNDED_ESCROW] } } } },
          {
            status: { in: [...UNPAID_STATUSES] },
            createdAt: { gte: new Date(Date.now() - UNPAID_BOARD_DAYS * 24 * 60 * 60 * 1000) },
          },
        ],
      },
      include: { customer: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const sandboxDriver = isStoreReviewerAccount(driver.email);
    const fits = shipments.filter((shipment) =>
      isStoreReviewerAccount(shipment.customer?.email) === sandboxDriver
      && trucks.some((truck) => this.truckFits(truck, shipment)),
    );
    const requests = await this.requestsFor(driverId, fits.map((shipment) => shipment.id));
    const position = this.validPosition(near) ?? this.freshPosition(availability);
    // A load whose customer accepted another driver's price is held for that driver.
    const heldForOthers = await this.heldShipments(fits.map((shipment) => shipment.id), driverId);
    const visible = fits.filter((shipment) => requests.get(shipment.id)?.status !== 'DECLINED' && !heldForOthers.has(shipment.id));
    const unpaidIds = visible.filter((shipment) => boardStatusOf(shipment) === 'AWAITING_PAYMENT').map((shipment) => shipment.id);
    const [quoteParts, rangePercent] = unpaidIds.length
      ? await Promise.all([this.quoteParts(unpaidIds), jobBoardPriceRangePercent(this.prisma)])
      : [new Map<string, QuoteParts>(), 0];

    const loads = visible
      .map((shipment) => {
        const boardStatus = boardStatusOf(shipment) ?? 'AWAITING_PAYMENT';
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
          boardStatus,
          paid: boardStatus !== 'AWAITING_PAYMENT',
          // Unpaid loads only: the trip pay a driver may propose instead of the quoted one.
          priceProposal: this.proposalTerms(quoteParts.get(shipment.id), rangePercent),
          proposedCarrierKobo: request?.status === 'PENDING' ? request.proposedCarrierKobo ?? null : null,
          proposedPriceKobo: request?.status === 'PENDING' ? request.proposedPriceKobo ?? null : null,
          priceAccepted: request?.status === 'PENDING' && Boolean(request.priceAcceptedAt),
        };
      })
      .sort((left, right) =>
        (left.pickupKm ?? Number.POSITIVE_INFINITY) - (right.pickupKm ?? Number.POSITIVE_INFINITY)
        // Without a position, paid loads first, then the newest.
        || Number(right.paid) - Number(left.paid)
        || right.postedAt.localeCompare(left.postedAt));

    const state: DriverBoardState = availability?.availableForAssignments === false ? 'OFFLINE' : 'OPEN';
    return { state, position, loads };
  }

  /**
   * A driver asks for a load on the board. Asking again for the same load is harmless.
   * `near` is the phone's position when they asked; the customer sees the pickup distance from it.
   */
  async request(driverId: string, shipmentRef: string, near?: DriverPosition | null, proposedCarrierKobo?: number | null) {
    await ensureJobRequestTable(this.prisma);
    const shipment = await this.findShipment(shipmentRef);
    const held = await this.reservedRequest(shipment.id);
    if (held && held.driverId !== driverId) throw new BadRequestException('This load is no longer on the job board.');
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
    const boardStatus = boardStatusOf(shipment);
    if (!boardStatus) throw new BadRequestException('This load is no longer on the job board.');
    // Same driver rules as a dispatch offer: no driver yet, driver verified and online, truck fits.
    // Payment and approval are only required when the customer chooses (see approve()).
    const { vehicle } = await this.shipments.checkAssignmentEligibility(shipment.id, driverId, undefined, {
      beforePayment: boardStatus !== 'READY',
    });
    const position = this.validPosition(near);
    const price = await this.checkProposal(shipment, boardStatus, proposedCarrierKobo);

    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `insert into "JobRequest" ("id", "shipmentId", "driverId", "vehicleId", "status", "requestLatitude", "requestLongitude",
         "proposedCarrierKobo", "proposedPriceKobo", "proposedCommissionKobo")
       values ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9)
       on conflict ("shipmentId", "driverId") do update
         set "status" = 'PENDING', "vehicleId" = excluded."vehicleId", "createdAt" = current_timestamp, "decidedAt" = null,
             "requestLatitude" = excluded."requestLatitude", "requestLongitude" = excluded."requestLongitude",
             "proposedCarrierKobo" = excluded."proposedCarrierKobo", "proposedPriceKobo" = excluded."proposedPriceKobo",
             "proposedCommissionKobo" = excluded."proposedCommissionKobo", "priceAcceptedAt" = null,
             "quoteBeforeKobo" = null, "feeBeforeKobo" = null, "driverPayBeforeKobo" = null
         where "JobRequest"."status" in ('WITHDRAWN', 'CLOSED')
       returning "id"`,
      `jobreq_${randomUUID().replace(/-/g, '')}`,
      shipment.id,
      driverId,
      vehicle.id,
      position?.latitude ?? null,
      position?.longitude ?? null,
      price?.carrierKobo ?? null,
      price?.totalKobo ?? null,
      price?.commissionKobo ?? null,
    );
    if (!inserted[0]) {
      const existing = (await this.requestsFor(driverId, [shipment.id])).get(shipment.id);
      if (existing?.status === 'PENDING') {
        if (existing.priceAcceptedAt) {
          // The customer already agreed a price with this driver; it cannot change under them.
          if (proposedCarrierKobo !== undefined && (price?.carrierKobo ?? null) !== (existing.proposedCarrierKobo ?? null)) {
            throw new BadRequestException(
              `The customer already accepted your price of ${this.formatMoney(existing.proposedCarrierKobo)} for this load.`,
            );
          }
        } else if (proposedCarrierKobo !== undefined) {
          // Asking again with a new price (or none) replaces the old proposal.
          await this.prisma.$executeRawUnsafe(
            `update "JobRequest" set "proposedCarrierKobo" = $2, "proposedPriceKobo" = $3, "proposedCommissionKobo" = $4
             where "id" = $1 and "priceAcceptedAt" is null`,
            existing.id,
            price?.carrierKobo ?? null,
            price?.totalKobo ?? null,
            price?.commissionKobo ?? null,
          );
        }
        // Asking again from a new spot keeps the customer's distance current.
        if (position) {
          await this.prisma.$executeRawUnsafe(
            `update "JobRequest" set "requestLatitude" = $2, "requestLongitude" = $3 where "id" = $1`,
            existing.id,
            position.latitude,
            position.longitude,
          );
        }
        return { requestId: existing.id, status: 'PENDING' as const };
      }
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
      body: price
        ? `${driverName} offered to carry ${shipment.reference} for ${this.formatMoney(price.totalKobo)} (your quote: ${this.formatMoney(shipment.quotedPriceKobo)}). Accept their price, or pay the quote and choose a driver.`
        : boardStatus === 'AWAITING_PAYMENT'
          ? `${driverName} asked to carry ${shipment.reference}. Pay for the shipment, then choose your driver.`
          : `${driverName} asked to carry ${shipment.reference}. Open the shipment to see the driver and choose.`,
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
    const withdrawn = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `update "JobRequest" set "status" = 'WITHDRAWN', "decidedAt" = current_timestamp
       where "shipmentId" = $1 and "driverId" = $2 and "status" = 'PENDING'
       returning ${JOB_REQUEST_COLUMNS}`,
      shipment.id,
      driverId,
    );
    const held = withdrawn.find((row) => row.priceAcceptedAt);
    if (held) {
      const restored = await this.restoreQuote(held, shipment, 'The driver whose price you accepted withdrew.');
      await this.notifications.create({
        userId: shipment.customerId,
        role: 'CUSTOMER',
        title: 'Driver withdrew',
        body: restored
          ? `The driver whose price you accepted withdrew from ${shipment.reference}. Your price is back to ${this.formatMoney(restored)} and other drivers can ask again.`
          : `The driver whose price you accepted withdrew from ${shipment.reference}. You keep the price you paid, and other drivers can ask for the load.`,
        tone: 'WARNING',
        entity: 'Shipment',
        entityId: shipment.id,
        actionUrl: `/customer/shipment/${shipment.id}`,
        preferenceKey: 'driverOffers',
      });
    }
    return { status: 'WITHDRAWN' as const };
  }

  /**
   * The customer (or operations for them) accepts a driver's proposed price before paying. The
   * shipment price, the amount to pay and Trako's commission change to match, every other request
   * is closed, and the load is held for this driver: they get it once it is paid and approved.
   */
  async acceptPrice(requestId: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const request = await this.findRequest(requestId);
    const shipment = await this.findShipment(request.shipmentId);
    this.assertCanChoose(shipment, userId, role);
    if (request.status !== 'PENDING') throw new BadRequestException('This driver request is no longer open.');
    if (request.proposedPriceKobo == null || request.proposedCarrierKobo == null) {
      throw new BadRequestException('This driver asked at your quoted price. Pay for the shipment, then choose them.');
    }
    if (request.priceAcceptedAt) return { status: 'PRICE_ACCEPTED' as const, quotedPriceKobo: shipment.quotedPriceKobo };
    if (boardStatusOf(shipment) !== 'AWAITING_PAYMENT') {
      throw new BadRequestException('This shipment is already paid, so its price can no longer change. Choose a driver at the price you paid.');
    }
    const escrow = await this.escrowOf(shipment.id);
    if (escrow && escrow.status !== 'PENDING') {
      throw new BadRequestException('This shipment is already paid, so its price can no longer change.');
    }
    // A payment for the old amount would not match the new one and would never fund the shipment.
    const [recentCheckout] = await this.prisma.$queryRawUnsafe<Array<{ createdAt: Date | string }>>(
      `select "createdAt" from "ShipmentTimeline"
       where "shipmentId" = $1 and "note" = 'Escrow payment initialized.' and "createdAt" > $2
       order by "createdAt" desc limit 1`,
      shipment.id,
      new Date(Date.now() - RECENT_CHECKOUT_MINUTES * 60_000),
    ).catch(() => []);
    if (recentCheckout?.createdAt) {
      const retryAt = new Date(new Date(recentCheckout.createdAt).getTime() + RECENT_CHECKOUT_MINUTES * 60_000);
      throw new ConflictException(
        `You opened a payment for this shipment a few minutes ago. If you paid it, wait for it to confirm. If not, you can accept this price after ${retryAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}.`,
      );
    }
    // Checked again now: the quote, its commission and the admin range may have changed since.
    const checked = await this.checkProposal(shipment, 'AWAITING_PAYMENT', request.proposedCarrierKobo);
    if (!checked) throw new BadRequestException('This driver asked at your quoted price. Pay for the shipment, then choose them.');

    const claimed = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `update "JobRequest" set "priceAcceptedAt" = current_timestamp, "quoteBeforeKobo" = $2, "feeBeforeKobo" = $3,
         "driverPayBeforeKobo" = $4, "proposedPriceKobo" = $5, "proposedCommissionKobo" = $6
       where "id" = $1 and "status" = 'PENDING' and "priceAcceptedAt" is null
         and not exists (select 1 from "JobRequest" other where other."shipmentId" = "JobRequest"."shipmentId"
           and other."id" <> "JobRequest"."id" and other."status" = 'PENDING' and other."priceAcceptedAt" is not null)
       returning "id"`,
      request.id,
      shipment.quotedPriceKobo,
      escrow?.platformFeeKobo ?? null,
      escrow?.driverPayKobo ?? null,
      checked.totalKobo,
      checked.commissionKobo,
    );
    if (!claimed[0]) throw new ConflictException('You already accepted another driver\'s price for this load.');

    const driverPayKobo = escrow?.driverPayKobo == null ? null : Math.min(escrow.driverPayKobo, checked.carrierKobo);
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        quotedPriceKobo: checked.totalKobo,
        timeline: {
          create: {
            status: shipment.status,
            note: `${role === 'CUSTOMER' ? 'Customer' : role === 'ADMIN' ? 'Admin' : 'Dispatch'} accepted a driver's price of ${this.formatMoney(checked.totalKobo)} `
              + `(trip ${this.formatMoney(checked.carrierKobo)} + Trako commission ${this.formatMoney(checked.commissionKobo)}); the quote was ${this.formatMoney(shipment.quotedPriceKobo)}.`,
          },
        },
      },
    });
    await ensurePlatformFeeColumn(this.prisma);
    await this.prisma.$executeRawUnsafe(
      `update "Escrow" set "amount" = $2, "platformFeeKobo" = $3, "driverPayKobo" = $4, "updatedAt" = current_timestamp
       where "shipmentId" = $1 and "status" = 'PENDING'::"EscrowStatus"`,
      shipment.id,
      checked.totalKobo,
      checked.commissionKobo,
      driverPayKobo,
    );

    const others = await this.prisma.$queryRawUnsafe<Array<{ driverId: string }>>(
      `update "JobRequest" set "status" = 'CLOSED', "decidedAt" = current_timestamp
       where "status" = 'PENDING' and "shipmentId" = $1 and "id" <> $2
       returning "driverId"`,
      shipment.id,
      request.id,
    ).catch(() => []);
    await this.notifications.create({
      userId: request.driverId,
      role: 'DRIVER',
      title: 'Your price was accepted',
      body: `The customer accepted ${this.formatMoney(checked.carrierKobo)} for ${shipment.reference}. The load is held for you; you get it once the customer pays and Trako approves it.`,
      tone: 'SUCCESS',
      entity: 'Shipment',
      entityId: shipment.id,
      actionUrl: '/driver/jobs',
      preferenceKey: 'driverOffers',
    });
    for (const other of others) {
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
    return { status: 'PRICE_ACCEPTED' as const, quotedPriceKobo: checked.totalKobo };
  }

  /** Drivers who asked for this load, for the customer who owns it and for operations. */
  async listForShipment(shipmentRef: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const shipment = await this.findShipment(shipmentRef);
    this.assertCanChoose(shipment, userId, role);

    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select ${JOB_REQUEST_COLUMNS}
       from "JobRequest" where "shipmentId" = $1 order by "createdAt" asc`,
      shipment.id,
    );
    const openAssignment = await this.prisma.driverAssignment.findFirst({
      where: { shipmentId: shipment.id, status: { in: ['OFFERED', 'ACCEPTED'] } },
      select: { id: true },
    });
    const boardStatus = openAssignment ? null : boardStatusOf(shipment);
    const onBoard = Boolean(boardStatus);
    const pending = rows.filter((row) => row.status === 'PENDING');
    const quotedPriceKobo = shipment.quotedPriceKobo ?? null;
    if (!pending.length) return { onBoard, boardStatus, quotedPriceKobo, requests: [] };

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
      const position = this.requestPosition(row, availabilityByDriver.get(driver.id));
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
        // The driver's own price (unpaid loads): what the customer would pay, and the driver's part.
        proposedPriceKobo: row.proposedPriceKobo ?? null,
        proposedCarrierKobo: row.proposedCarrierKobo ?? null,
        proposedCommissionKobo: row.proposedCommissionKobo ?? null,
        priceAccepted: Boolean(row.priceAcceptedAt),
      }];
    });
    return { onBoard, boardStatus, quotedPriceKobo, requests };
  }

  /** The customer (or operations) picks a driver: the load becomes that driver's accepted job. */
  async approve(requestId: string, userId: string, role: UserRole) {
    await ensureJobRequestTable(this.prisma);
    const request = await this.findRequest(requestId);
    const shipment = await this.findShipment(request.shipmentId);
    this.assertCanChoose(shipment, userId, role);
    if (request.status !== 'PENDING') throw new BadRequestException('This driver request is no longer open.');
    // Drivers may ask before payment, but nobody is given the load until the money is held.
    const boardStatus = boardStatusOf(shipment);
    if (boardStatus === 'AWAITING_PAYMENT') {
      throw new BadRequestException('Pay for this shipment first, then choose your driver. Their request stays open.');
    }
    if (boardStatus === 'AWAITING_APPROVAL') {
      throw new BadRequestException('Trako is checking this paid load. You can choose a driver as soon as it is approved.');
    }
    const held = await this.reservedRequest(shipment.id);
    if (held && held.id !== request.id) {
      throw new BadRequestException('You accepted another driver\'s price for this load. Decline that driver first to choose someone else.');
    }
    return this.assignRequest(request, shipment, role);
  }

  /** Gives the load to the driver of this request: an accepted assignment, and every other request closed. */
  private async assignRequest(
    request: JobRequestRow,
    shipment: Awaited<ReturnType<JobBoardService['findShipment']>>,
    chosenBy: UserRole | 'SYSTEM',
  ) {
    const requestId = request.id;
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

    const chosenByCustomer = chosenBy === 'CUSTOMER';
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: 'DRIVER_EN_ROUTE',
        timeline: {
          create: {
            status: 'DRIVER_EN_ROUTE',
            note: chosenByCustomer
              ? 'Customer chose a driver from the job board.'
              : chosenBy === 'SYSTEM'
                ? 'Paid and approved: the driver whose price the customer accepted now has the load.'
                : `${chosenBy === 'ADMIN' ? 'Admin' : 'Dispatch'} chose a driver from the job board for the customer.`,
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
      body: chosenBy === 'SYSTEM'
        ? `${shipment.reference} is paid and approved at the price you agreed. Head to the pickup when you are ready.`
        : `The customer chose you for ${shipment.reference}. Head to the pickup when you are ready.`,
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
        body: chosenBy === 'SYSTEM'
          ? `Your payment is approved. The driver whose price you accepted is now assigned to ${shipment.reference}.`
          : `Trako operations confirmed a driver for ${shipment.reference}.`,
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
    // Declining the driver whose price was accepted puts the quote back while still unpaid.
    if (request.priceAcceptedAt) await this.restoreQuote(request, shipment, 'The customer declined the driver whose price they had accepted.');
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
      `select ${JOB_REQUEST_COLUMNS}
       from "JobRequest" where "id" = $1 limit 1`,
      requestId,
    );
    if (!rows[0]) throw new NotFoundException('Driver request not found.');
    return rows[0];
  }

  private async requestsFor(driverId: string, shipmentIds: string[]) {
    if (!shipmentIds.length) return new Map<string, JobRequestRow>();
    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select ${JOB_REQUEST_COLUMNS}
       from "JobRequest" where "driverId" = $1 and "shipmentId" = any($2::text[])`,
      driverId,
      shipmentIds,
    );
    return new Map(rows.map((row) => [row.shipmentId, row]));
  }

  /** The request whose price the customer accepted, if the load is held for a driver. */
  private async reservedRequest(shipmentId: string) {
    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select ${JOB_REQUEST_COLUMNS}
       from "JobRequest" where "shipmentId" = $1 and "status" = 'PENDING' and "priceAcceptedAt" is not null limit 1`,
      shipmentId,
    );
    return rows.find((row) => row.status === 'PENDING' && row.priceAcceptedAt && row.shipmentId === shipmentId) ?? null;
  }

  /** Of these shipments, the ones held for a driver other than this one. */
  private async heldShipments(shipmentIds: string[], driverId: string) {
    if (!shipmentIds.length) return new Set<string>();
    const rows = await this.prisma.$queryRawUnsafe<JobRequestRow[]>(
      `select ${JOB_REQUEST_COLUMNS}
       from "JobRequest" where "shipmentId" = any($1::text[]) and "status" = 'PENDING' and "priceAcceptedAt" is not null`,
      shipmentIds,
    );
    return new Set(rows
      .filter((row) => row.status === 'PENDING' && row.priceAcceptedAt && row.driverId !== driverId)
      .map((row) => row.shipmentId));
  }

  /**
   * Commission and running cost for each shipment, from its latest signed quote (the booking's
   * audit record). Shipments without a usable quote are left out and take no proposals.
   */
  private async quoteParts(shipmentIds: string[]) {
    const parts = new Map<string, QuoteParts>();
    if (!shipmentIds.length) return parts;
    const auditLog = this.prisma.auditLog;
    if (!auditLog?.findMany) return parts;
    const snapshots = await auditLog.findMany({
      where: { action: 'SHIPMENT_QUOTE_ACCEPTED', entity: 'Shipment', entityId: { in: shipmentIds } },
      orderBy: { createdAt: 'desc' },
      select: { entityId: true, metadata: true },
    }).catch(() => []);
    for (const snapshot of snapshots ?? []) {
      if (!snapshot.entityId || parts.has(snapshot.entityId)) continue;
      const metadata = (snapshot.metadata ?? {}) as { quotedPriceKobo?: unknown; pricingBreakdown?: unknown };
      const quote = quotePartsFrom(Number(metadata.quotedPriceKobo), metadata.pricingBreakdown);
      if (quote) parts.set(snapshot.entityId, quote);
    }
    return parts;
  }

  /** What the driver app needs to offer a price: the quoted trip pay, its floor and ceiling. */
  private proposalTerms(parts: QuoteParts | undefined, rangePercent: number) {
    if (!parts) return null;
    const bounds = proposalBounds(parts, rangePercent);
    if (!bounds) return null;
    return {
      quotedCarrierKobo: parts.carrierKobo,
      runningCostKobo: parts.runningCostKobo,
      commissionRate: parts.commissionRate,
      minCarrierKobo: bounds.minCarrierKobo,
      maxCarrierKobo: bounds.maxCarrierKobo,
    };
  }

  /**
   * Checks a driver's proposed trip pay. Undefined/null (or the quoted pay itself) means no
   * proposal. Otherwise: unpaid loads only, at or above the running cost, within the admin range.
   */
  private async checkProposal(
    shipment: { id: string; status: string; adminApproved: boolean },
    boardStatus: string | null,
    proposedCarrierKobo: number | null | undefined,
  ) {
    if (proposedCarrierKobo === undefined || proposedCarrierKobo === null) return null;
    if (!Number.isFinite(proposedCarrierKobo) || proposedCarrierKobo <= 0) {
      throw new BadRequestException('Enter the amount you want for this trip.');
    }
    if (boardStatus !== 'AWAITING_PAYMENT') {
      throw new BadRequestException('You can only offer your own price before the customer pays. Ask for this load at the paid price.');
    }
    const parts = (await this.quoteParts([shipment.id])).get(shipment.id);
    const rangePercent = await jobBoardPriceRangePercent(this.prisma);
    const bounds: ProposalBounds | null = parts ? proposalBounds(parts, rangePercent) : null;
    if (!parts || !bounds) {
      throw new BadRequestException('This load does not take price offers. Ask for it at the quoted price.');
    }
    const price = priceForCarrier(parts, proposedCarrierKobo);
    if (price.carrierKobo === parts.carrierKobo) return null;
    if (price.carrierKobo < bounds.minCarrierKobo || price.carrierKobo > bounds.maxCarrierKobo) {
      const floorNote = bounds.minCarrierKobo <= parts.runningCostKobo + 100 ? ' (below that the trip does not cover fuel and running costs)' : '';
      throw new BadRequestException(
        `Offer between ${this.formatMoney(bounds.minCarrierKobo)}${floorNote} and ${this.formatMoney(bounds.maxCarrierKobo)} for this trip.`,
      );
    }
    return price;
  }

  private async escrowOf(shipmentId: string) {
    await ensurePlatformFeeColumn(this.prisma);
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      status: string;
      amount: number;
      platformFeeKobo: number | null;
      driverPayKobo: number | null;
    }>>(
      `select "status"::text as "status", "amount", "platformFeeKobo", "driverPayKobo" from "Escrow" where "shipmentId" = $1 limit 1`,
      shipmentId,
    );
    return rows.find((row) => typeof row?.status === 'string' && 'amount' in row) ?? null;
  }

  /**
   * Puts the shipment's price, amount to pay and commission back to what they were before a
   * driver's price was accepted. Only while unpaid: a paid price is never changed. Returns the
   * restored price, or null when nothing was changed.
   */
  private async restoreQuote(request: JobRequestRow, shipment: { id: string; status: string; adminApproved: boolean }, note: string) {
    if (request.quoteBeforeKobo == null || boardStatusOf(shipment) !== 'AWAITING_PAYMENT') return null;
    const escrow = await this.escrowOf(shipment.id);
    if (escrow && escrow.status !== 'PENDING') return null;
    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        quotedPriceKobo: request.quoteBeforeKobo,
        timeline: { create: { status: shipment.status as never, note: `${note} Price back to ${this.formatMoney(request.quoteBeforeKobo)}.` } },
      },
    });
    await this.prisma.$executeRawUnsafe(
      `update "Escrow" set "amount" = $2, "platformFeeKobo" = $3, "driverPayKobo" = $4, "updatedAt" = current_timestamp
       where "shipmentId" = $1 and "status" = 'PENDING'::"EscrowStatus"`,
      shipment.id,
      request.quoteBeforeKobo,
      request.feeBeforeKobo ?? null,
      request.driverPayBeforeKobo ?? null,
    );
    return request.quoteBeforeKobo;
  }

  private formatMoney(amountKobo?: number | null) {
    return `NGN ${Math.round(Number(amountKobo ?? 0) / 100).toLocaleString('en-US')}`;
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

  private validPosition(position?: DriverPosition | null) {
    if (!position) return null;
    const { latitude, longitude } = position;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  }

  /**
   * Where to measure a requesting driver from: the newer of the phone position sent with the
   * request and the driver's last trip GPS (if still fresh). Before 24 Nov 2026 only the trip GPS
   * was used, so a driver who asked from near the pickup could show as far away.
   */
  private requestPosition(
    request: JobRequestRow,
    gps: { lastKnownLatitude: number | null; lastKnownLongitude: number | null; locationUpdatedAt: Date | string | null } | undefined,
  ) {
    const asked = this.validPosition(
      request.requestLatitude == null || request.requestLongitude == null
        ? null
        : { latitude: Number(request.requestLatitude), longitude: Number(request.requestLongitude) },
    );
    const tracked = this.freshPosition(gps);
    if (!asked || !tracked || !gps?.locationUpdatedAt) return asked ?? tracked;
    return new Date(gps.locationUpdatedAt).getTime() > new Date(request.createdAt).getTime() ? tracked : asked;
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
