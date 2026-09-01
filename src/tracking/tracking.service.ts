import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/types/auth-user';

type LocationInput = {
  latitude?: number;
  longitude?: number;
  heading?: number;
  speedKph?: number;
  note?: string;
};

type DeliveryProofInput = {
  photoUrl?: string;
  signatureUrl?: string;
  recipientName?: string;
  note?: string;
};

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // Authentication alone isn't enough here - a logged-in customer must not be able to
  // read another customer's live GPS trail or delivery photos just by knowing/guessing a
  // shipment id. ADMIN/DISPATCHER get operational visibility across all shipments.
  private async assertShipmentAccess(shipmentIdentifier: string, user: AuthUser) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { OR: [{ id: shipmentIdentifier }, { reference: shipmentIdentifier }] },
      select: { id: true, customerId: true },
    }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment was not found.');

    if (user.role === 'ADMIN' || user.role === 'DISPATCHER') return shipment.id;
    if (user.role === 'CUSTOMER' && shipment.customerId === user.sub) return shipment.id;

    if (user.role === 'DRIVER') {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId: shipment.id, driverId: user.sub, status: 'ACCEPTED' },
        select: { id: true },
      }).catch(() => null);
      if (assignment) return shipment.id;
    }

    throw new ForbiddenException('You do not have access to this shipment.');
  }

  async currentLocation(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          shipmentId: string;
          driverId: string | null;
          latitude: number;
          longitude: number;
          heading: number | null;
          speedKph: number | null;
          note: string | null;
          createdAt: Date;
        }[]
      >(
        `select "id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "createdAt"
         from "ShipmentLocationPing"
         where "shipmentId" = $1
         order by "createdAt" desc
         limit 1`,
        shipmentId,
      );

      if (rows[0]) return this.toLocation(rows[0]);
    } catch {
      // A real infra failure falls through to the honest "no location yet" below too.
    }

    // This used to fabricate a fixed Lagos coordinate here - so a customer/dispatcher
    // watching this shipment before the driver had ever sent a real GPS ping saw a truck
    // marker sitting at a location nothing actually reported. Every caller (track.tsx,
    // live-map.tsx) already handles null/empty correctly - it just never got the honest
    // "no ping yet" signal.
    return null;
  }

  async locationHistory(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          shipmentId: string;
          driverId: string | null;
          latitude: number;
          longitude: number;
          heading: number | null;
          speedKph: number | null;
          note: string | null;
          createdAt: Date;
        }[]
      >(
        `select "id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "createdAt"
         from "ShipmentLocationPing"
         where "shipmentId" = $1
         order by "createdAt" desc
         limit 100`,
        shipmentId,
      );

      if (rows.length) return rows.map((row) => this.toLocation(row));
    } catch {
      // A real infra failure falls through to the honest empty list below too.
    }

    // Same fabricated-Lagos-coordinate bug as currentLocation() above, for the route
    // trail - an honest empty list, not an invented single-point "route".
    return [];
  }

  async recordLocation(shipmentId: string, user: AuthUser, input: LocationInput) {
    // A driver may only post location updates for a shipment they are actually assigned
    // to - otherwise anyone with a valid driver token could spoof any shipment's route.
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    const driverId = user.sub;
    // This used to default a missing latitude/longitude to a fixed Lagos coordinate -
    // the exact same fabricated-location bug as the fixes below, just moved to the write
    // path: a malformed or incomplete GPS payload (a client bug, permissions edge case,
    // truncated request) would get silently recorded into the permanent trail as if the
    // driver were really sitting in Lagos, misleading every customer/dispatcher watching
    // this shipment's live map. A ping without real coordinates must be rejected instead.
    if (input.latitude == null || input.longitude == null) {
      throw new BadRequestException('A real GPS latitude and longitude are required to record a location.');
    }
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new BadRequestException('A valid GPS latitude and longitude are required to record a location.');
    }

    // This used to echo the submitted coordinates straight back as a fake "saved" ping
    // whenever the INSERT failed - so a driver's GPS trail could silently stop being
    // recorded (DB error, connection drop) while the driver-side reporter, the pickup
    // confirmation flow, and the trip-stage-advance flow all believed every ping saved
    // fine. A location that wasn't actually saved must surface as a real error.
    let rows: {
      id: string;
      shipmentId: string;
      driverId: string | null;
      latitude: number;
      longitude: number;
      heading: number | null;
      speedKph: number | null;
      note: string | null;
      createdAt: Date;
    }[];
    try {
      rows = await this.prisma.$queryRawUnsafe(
        `insert into "ShipmentLocationPing" ("id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note")
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning "id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "createdAt"`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own, or every location ping ever
        // sent silently fails.
        `ping_${randomUUID().replace(/-/g, '')}`,
        shipmentId,
        driverId.startsWith('preview-') ? null : driverId,
        latitude,
        longitude,
        input.heading ?? null,
        input.speedKph ?? null,
        input.note ?? null,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not record this location. Please try again: ${this.errorMessage(error)}`);
    }

    if (!rows[0]) throw new InternalServerErrorException('Could not record this location. Please try again.');
    return this.toLocation(rows[0]);
  }

  async submitDeliveryProof(shipmentId: string, user: AuthUser, input: DeliveryProofInput) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    const driverId = user.sub;

    // This used to wrap the real proof insert, the shipment's DELIVERED transition, the
    // Escrow proofOfDeliveryUploaded flip, AND the two best-effort notifications in one
    // try/catch - so ANY failure among them, including just a notification hiccup after
    // everything else had already saved, fell back to a fabricated "SUBMITTED" proof
    // signed by "Preview recipient". A driver could believe delivery proof was recorded
    // while nothing was actually saved: the shipment never moved to DELIVERED, escrow's
    // release checklist never advanced, and the driver could go unpaid with no error ever
    // surfaced. The core write now fails loudly; notifications stay best-effort after it.
    let rows: {
      id: string;
      shipmentId: string;
      driverId: string | null;
      photoUrl: string | null;
      signatureUrl: string | null;
      recipientName: string | null;
      note: string | null;
      status: string;
      submittedAt: Date;
    }[];
    let customerId: string;
    try {
      rows = await this.prisma.$queryRawUnsafe(
        `insert into "DeliveryProof" ("id", "shipmentId", "driverId", "photoUrl", "signatureUrl", "recipientName", "note", "status")
         values ($1, $2, $3, $4, $5, $6, $7, 'SUBMITTED'::"ProofStatus")
         returning "id", "shipmentId", "driverId", "photoUrl", "signatureUrl", "recipientName", "note", "status"::text as "status", "submittedAt"`,
        // "id" has no database-level default (Prisma's @default(cuid()) is client-side
        // only) - this raw insert must generate its own, or the delivery photo/signature
        // silently never gets saved even though the shipment still flips to DELIVERED.
        `proof_${randomUUID().replace(/-/g, '')}`,
        shipmentId,
        driverId.startsWith('preview-') ? null : driverId,
        input.photoUrl ?? null,
        input.signatureUrl ?? null,
        input.recipientName ?? null,
        input.note ?? null,
      );
      if (!rows[0]) throw new Error('Delivery proof insert returned no row.');

      const shipment = await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: {
          status: 'DELIVERED',
          timeline: {
            create: {
              status: 'DELIVERED',
              note: 'Proof of delivery submitted.',
            },
          },
        },
      });
      customerId = shipment.customerId;

      await this.prisma.$executeRawUnsafe(
        `update "Escrow"
         set "proofOfDeliveryUploaded" = true,
             "status" = case
               when "status" in ('DISPUTED'::"EscrowStatus", 'REFUNDED'::"EscrowStatus", 'RELEASED'::"EscrowStatus") then "status"
               when "arrivalConfirmed" = true
                and "customerDeliveryConfirmed" = true
                and "disputeWindowClear" = true
                and "platformApproved" = true
               then 'RELEASE_READY'::"EscrowStatus"
               else "status"
             end,
             "updatedAt" = current_timestamp
         where "shipmentId" = $1`,
        shipmentId,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not record proof of delivery. Please try again: ${this.errorMessage(error)}`);
    }

    await Promise.all([
      this.notifications.create({
        userId: customerId,
        title: 'Proof of delivery submitted',
        body: 'The driver uploaded delivery proof for your shipment.',
        tone: 'SUCCESS',
        entity: 'DeliveryProof',
        entityId: rows[0].id,
        actionUrl: `/shipments/${shipmentId}`,
      }),
      this.notifications.create({
        role: 'DISPATCHER',
        title: 'Delivery proof received',
        body: 'A driver submitted proof of delivery for review.',
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: `/dispatcher/shipments/${shipmentId}`,
      }),
    ]).catch(() => null);

    return this.toProof(rows[0]);
  }

  async deliveryProofs(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          shipmentId: string;
          driverId: string | null;
          photoUrl: string | null;
          signatureUrl: string | null;
          recipientName: string | null;
          note: string | null;
          status: string;
          submittedAt: Date;
        }[]
      >(
        `select "id", "shipmentId", "driverId", "photoUrl", "signatureUrl", "recipientName", "note", "status"::text as "status", "submittedAt"
         from "DeliveryProof"
         where "shipmentId" = $1
         order by "submittedAt" desc`,
        shipmentId,
      );

      if (rows.length) return rows.map((row) => this.toProof(row));
    } catch {
      // A real infra failure falls through to the honest empty list below too.
    }

    // This used to fabricate a "SUBMITTED" proof of delivery, signed by "Preview
    // recipient", for a shipment that had never actually been delivered - shown directly
    // to the customer on the delivery-confirmation screen. An honest empty list instead;
    // every caller already handles zero proofs correctly.
    return [];
  }

  private toLocation(row: {
    id: string;
    shipmentId: string;
    driverId: string | null;
    latitude: number;
    longitude: number;
    heading: number | null;
    speedKph: number | null;
    note: string | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      shipmentId: row.shipmentId,
      driverId: row.driverId ?? undefined,
      latitude: row.latitude,
      longitude: row.longitude,
      heading: row.heading ?? undefined,
      speedKph: row.speedKph ?? undefined,
      note: row.note ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toProof(row: {
    id: string;
    shipmentId: string;
    driverId: string | null;
    photoUrl: string | null;
    signatureUrl: string | null;
    recipientName: string | null;
    note: string | null;
    status: string;
    submittedAt: Date;
  }) {
    return {
      id: row.id,
      shipmentId: row.shipmentId,
      driverId: row.driverId ?? undefined,
      photoUrl: row.photoUrl ?? undefined,
      signatureUrl: row.signatureUrl ?? undefined,
      recipientName: row.recipientName ?? undefined,
      note: row.note ?? undefined,
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
    };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
