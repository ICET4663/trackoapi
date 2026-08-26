import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
  private async assertShipmentAccess(shipmentId: string, user: AuthUser) {
    if (user.role === 'ADMIN' || user.role === 'DISPATCHER') return;

    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: { customerId: true },
    }).catch(() => null);
    if (!shipment) throw new NotFoundException('Shipment was not found.');

    if (user.role === 'CUSTOMER' && shipment.customerId === user.sub) return;

    if (user.role === 'DRIVER') {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId, driverId: user.sub, status: 'ACCEPTED' },
        select: { id: true },
      }).catch(() => null);
      if (assignment) return;
    }

    throw new ForbiddenException('You do not have access to this shipment.');
  }

  async currentLocation(shipmentId: string, user: AuthUser) {
    await this.assertShipmentAccess(shipmentId, user);
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
      // Preview fallback below.
    }

    return this.previewLocation(shipmentId);
  }

  async locationHistory(shipmentId: string, user: AuthUser) {
    await this.assertShipmentAccess(shipmentId, user);
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
      // Preview fallback below.
    }

    return [this.previewLocation(shipmentId)];
  }

  async recordLocation(shipmentId: string, user: AuthUser, input: LocationInput) {
    // A driver may only post location updates for a shipment they are actually assigned
    // to - otherwise anyone with a valid driver token could spoof any shipment's route.
    await this.assertShipmentAccess(shipmentId, user);
    const driverId = user.sub;
    const latitude = Number(input.latitude ?? 6.5244);
    const longitude = Number(input.longitude ?? 3.3792);

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
        `insert into "ShipmentLocationPing" ("shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note")
         values ($1, $2, $3, $4, $5, $6, $7)
         returning "id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "createdAt"`,
        shipmentId,
        driverId.startsWith('preview-') ? null : driverId,
        latitude,
        longitude,
        input.heading ?? null,
        input.speedKph ?? null,
        input.note ?? null,
      );

      if (rows[0]) return this.toLocation(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return this.previewLocation(shipmentId, {
      driverId,
      latitude,
      longitude,
      heading: input.heading,
      speedKph: input.speedKph,
      note: input.note,
    });
  }

  async submitDeliveryProof(shipmentId: string, user: AuthUser, input: DeliveryProofInput) {
    await this.assertShipmentAccess(shipmentId, user);
    const driverId = user.sub;
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
        `insert into "DeliveryProof" ("shipmentId", "driverId", "photoUrl", "signatureUrl", "recipientName", "note", "status")
         values ($1, $2, $3, $4, $5, $6, 'SUBMITTED'::"ProofStatus")
         returning "id", "shipmentId", "driverId", "photoUrl", "signatureUrl", "recipientName", "note", "status"::text as "status", "submittedAt"`,
        shipmentId,
        driverId.startsWith('preview-') ? null : driverId,
        input.photoUrl ?? null,
        input.signatureUrl ?? null,
        input.recipientName ?? null,
        input.note ?? null,
      );

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

      await this.notifications.create({
        userId: shipment.customerId,
        title: 'Proof of delivery submitted',
        body: 'The driver uploaded delivery proof for your shipment.',
        tone: 'SUCCESS',
        entity: 'DeliveryProof',
        entityId: rows[0]?.id,
        actionUrl: `/shipments/${shipmentId}`,
      });

      await this.notifications.create({
        role: 'DISPATCHER',
        title: 'Delivery proof received',
        body: 'A driver submitted proof of delivery for review.',
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: `/dispatcher/shipments/${shipmentId}`,
      });

      if (rows[0]) return this.toProof(rows[0]);
    } catch {
      // Preview fallback below.
    }

    return this.previewProof(shipmentId, driverId, input);
  }

  async deliveryProofs(shipmentId: string, user: AuthUser) {
    await this.assertShipmentAccess(shipmentId, user);
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
      // Preview fallback below.
    }

    return [this.previewProof(shipmentId, 'preview-driver', {})];
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

  private previewLocation(shipmentId: string, input: Partial<LocationInput & { driverId: string }> = {}) {
    return {
      id: `loc-${Date.now()}`,
      shipmentId,
      driverId: input.driverId ?? 'preview-driver',
      latitude: Number(input.latitude ?? 6.5244),
      longitude: Number(input.longitude ?? 3.3792),
      heading: input.heading,
      speedKph: input.speedKph,
      note: input.note ?? 'Preview location ping.',
      createdAt: new Date().toISOString(),
    };
  }

  private previewProof(shipmentId: string, driverId: string, input: DeliveryProofInput) {
    return {
      id: `pod-${Date.now()}`,
      shipmentId,
      driverId,
      photoUrl: input.photoUrl,
      signatureUrl: input.signatureUrl,
      recipientName: input.recipientName ?? 'Preview recipient',
      note: input.note ?? 'Preview proof of delivery.',
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
    };
  }
}
