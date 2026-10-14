import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MapsProviderService } from '../integrations/maps-provider.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/types/auth-user';

type LocationInput = {
  latitude?: number;
  longitude?: number;
  heading?: number;
  speedKph?: number;
  note?: string;
  // When the device actually captured this fix (ISO string or epoch ms). Lets a delayed,
  // queued update keep its real time instead of looking brand new on arrival.
  recordedAt?: string | number;
  // Horizontal GPS accuracy in metres, as reported by the device.
  accuracyM?: number;
  // Device-generated id, unique per fix: a retried request after a network timeout
  // returns the original ping instead of storing a duplicate.
  clientPingId?: string;
};

type LocationRow = {
  id: string;
  shipmentId: string;
  driverId: string | null;
  latitude: number;
  longitude: number;
  heading: number | null;
  speedKph: number | null;
  note: string | null;
  createdAt: Date;
  recordedAt?: Date | null;
  accuracyM?: number | null;
};

// A device clock a little ahead of ours is normal; far ahead is a bad clock or spoofing.
const MAX_FUTURE_SKEW_MS = 2 * 60_000;
// An offline queue is bounded; a fix older than this is no longer useful for a live trip.
const MAX_PING_AGE_MS = 12 * 60 * 60_000;
// Alerts compare recent positions, so only evaluate them for a fix that is itself recent.
const ALERT_FRESHNESS_MS = 90_000;
// How long a finished shipment's GPS trail is kept. Admin-configurable (platform setting
// trackingRetentionDays); location is personal data, so it should not be kept indefinitely.
const DEFAULT_LOCATION_RETENTION_DAYS = 30;
const MIN_LOCATION_RETENTION_DAYS = 7;
const MAX_LOCATION_RETENTION_DAYS = 365;
const EFFECTIVE_TIME = 'coalesce("recordedAt", "createdAt")';
const LOCATION_COLUMNS = `"id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "createdAt", "recordedAt", "accuracyM"`;

type DeliveryProofInput = {
  photoUrl?: string;
  signatureUrl?: string;
  recipientName?: string;
  note?: string;
};

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly maps: MapsProviderService,
  ) {}

  // Additive, nullable columns created lazily (the same pattern used elsewhere in this
  // codebase) so older rows and a rollback to the previous release both keep working -
  // nothing reads these columns except this service. Memoized: this runs on every GPS
  // ping, and re-issuing DDL each time would be wasted load. A failure clears the cache
  // so the next request retries instead of leaving tracking broken.
  private locationColumnsReady?: Promise<void>;

  private ensureLocationColumns() {
    this.locationColumnsReady ??= (async () => {
      await this.prisma.$executeRawUnsafe('alter table "ShipmentLocationPing" add column if not exists "recordedAt" timestamp(3)');
      await this.prisma.$executeRawUnsafe('alter table "ShipmentLocationPing" add column if not exists "accuracyM" double precision');
      await this.prisma.$executeRawUnsafe('alter table "ShipmentLocationPing" add column if not exists "clientPingId" text');
      await this.prisma.$executeRawUnsafe(
        'create unique index if not exists "ShipmentLocationPing_shipment_clientPing_key" on "ShipmentLocationPing" ("shipmentId", "clientPingId") where "clientPingId" is not null',
      );
      await this.prisma.$executeRawUnsafe(
        `create index if not exists "ShipmentLocationPing_shipment_effective_idx" on "ShipmentLocationPing" ("shipmentId", (coalesce("recordedAt", "createdAt")) desc)`,
      );
    })().catch((error) => {
      this.locationColumnsReady = undefined;
      throw error;
    });
    return this.locationColumnsReady;
  }

  private routeColumnReady?: Promise<void>;

  private ensureRouteColumn() {
    this.routeColumnReady ??= this.prisma.$executeRawUnsafe(
      'alter table "Shipment" add column if not exists "plannedRoutePolyline" text',
    ).then(() => undefined).catch((error) => {
      this.routeColumnReady = undefined;
      throw error;
    });
    return this.routeColumnReady;
  }

  // The road route Google plans from pickup to destination, drawn on trip maps beside the
  // route actually driven. Fetched from Google once per shipment, the first time anyone
  // looks, then stored - so it covers shipments booked before this existed and costs one
  // Routes call per shipment, not one per map refresh. It is a plan, not where the truck is.
  async plannedRoute(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    let row: {
      pickupLatitude: number | null; pickupLongitude: number | null;
      destinationLatitude: number | null; destinationLongitude: number | null;
      plannedRoutePolyline: string | null;
    } | undefined;
    try {
      await this.ensureRouteColumn();
      [row] = await this.prisma.$queryRawUnsafe<NonNullable<typeof row>[]>(
        `select "pickupLatitude", "pickupLongitude", "destinationLatitude", "destinationLongitude", "plannedRoutePolyline"
         from "Shipment" where "id" = $1`,
        shipmentId,
      );
    } catch (error) {
      throw new InternalServerErrorException(`Could not load the planned route: ${this.errorMessage(error)}`);
    }
    if (!row) throw new NotFoundException('Shipment was not found.');
    if (row.plannedRoutePolyline) return { encodedPolyline: row.plannedRoutePolyline };

    const { pickupLatitude, pickupLongitude, destinationLatitude, destinationLongitude } = row;
    if (pickupLatitude == null || pickupLongitude == null || destinationLatitude == null || destinationLongitude == null) {
      return { encodedPolyline: null };
    }
    const route = await this.maps.roadRoute(
      { latitude: pickupLatitude, longitude: pickupLongitude },
      { latitude: destinationLatitude, longitude: destinationLongitude },
    );
    if (!route) return { encodedPolyline: null };
    await this.prisma.$executeRawUnsafe(
      'update "Shipment" set "plannedRoutePolyline" = $2 where "id" = $1 and "plannedRoutePolyline" is null',
      shipmentId,
      route.encodedPolyline,
    ).catch((error) => this.logger.warn(`Could not store the planned route for ${shipmentId}: ${this.errorMessage(error)}`));
    return { encodedPolyline: route.encodedPolyline };
  }

  // Authentication alone isn't enough here - a logged-in customer must not be able to
  // read another customer's live GPS trail or delivery photos just by knowing/guessing a
  // shipment id. ADMIN/DISPATCHER get operational visibility across all shipments.
  private async assertShipmentAccess(shipmentIdentifier: string, user: AuthUser) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { OR: [{ id: shipmentIdentifier }, { reference: shipmentIdentifier }] },
      select: { id: true, customerId: true },
    }).catch(() => { throw new InternalServerErrorException('Could not check shipment access. Please try again.'); });
    if (!shipment) throw new NotFoundException('Shipment was not found.');

    if (user.role === 'ADMIN' || user.role === 'DISPATCHER') return shipment.id;
    if (user.role === 'CUSTOMER' && shipment.customerId === user.sub) return shipment.id;

    if (user.role === 'DRIVER') {
      const assignment = await this.prisma.driverAssignment.findFirst({
        where: { shipmentId: shipment.id, driverId: user.sub, status: 'ACCEPTED' },
        select: { id: true },
      }).catch(() => { throw new InternalServerErrorException('Could not check driver assignment. Please try again.'); });
      if (assignment) return shipment.id;
    }

    throw new ForbiddenException('You do not have access to this shipment.');
  }

  async currentLocation(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    try {
      await this.ensureLocationColumns();
      // "Latest" means the newest fix by when it was CAPTURED, not when it arrived - a
      // delayed update from an offline queue must never replace a newer position.
      const rows = await this.prisma.$queryRawUnsafe<LocationRow[]>(
        `select ${LOCATION_COLUMNS}
         from "ShipmentLocationPing"
         where "shipmentId" = $1
         order by ${EFFECTIVE_TIME} desc, "createdAt" desc
         limit 1`,
        shipmentId,
      );

      if (rows[0]) return this.toLocation(rows[0]);
    } catch {
      throw new InternalServerErrorException('Could not load the current location. Please try again.');
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
      await this.ensureLocationColumns();
      const rows = await this.prisma.$queryRawUnsafe<LocationRow[]>(
        `select ${LOCATION_COLUMNS}
         from "ShipmentLocationPing"
         where "shipmentId" = $1
         order by ${EFFECTIVE_TIME} desc, "createdAt" desc
         limit 100`,
        shipmentId,
      );

      if (rows.length) return rows.map((row) => this.toLocation(row));
    } catch {
      throw new InternalServerErrorException('Could not load location history. Please try again.');
    }

    // Same fabricated-Lagos-coordinate bug as currentLocation() above, for the route
    // trail - an honest empty list, not an invented single-point "route".
    return [];
  }

  async locationRetentionDays() {
    const setting = await this.prisma.platformSetting.findUnique({ where: { key: 'trackingRetentionDays' } }).catch(() => null);
    const configured = Math.floor(Number(setting?.value));
    if (!Number.isFinite(configured)) return DEFAULT_LOCATION_RETENTION_DAYS;
    return Math.min(MAX_LOCATION_RETENTION_DAYS, Math.max(MIN_LOCATION_RETENTION_DAYS, configured));
  }

  // Deletes the GPS trail of shipments that finished (completed or cancelled) more than the
  // retention window ago. A shipment with an open or in-review dispute is never touched: the
  // trail is evidence there. Work is done in bounded batches so one run cannot hold the
  // database for long; whatever is left is picked up by the next scheduled run.
  async purgeExpiredLocationHistory(options: { batchSize?: number; maxBatches?: number } = {}) {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 2000, 10_000));
    const maxBatches = Math.max(1, options.maxBatches ?? 5);
    const retentionDays = await this.locationRetentionDays();

    let deleted = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const rows = await this.prisma.$queryRawUnsafe<{ count: number | bigint }[]>(
          `with expired as (
             select p."id"
             from "ShipmentLocationPing" p
             join "Shipment" s on s."id" = p."shipmentId"
             where s."status" in ('COMPLETED'::"ShipmentStatus", 'CANCELLED'::"ShipmentStatus")
               and s."updatedAt" <= now() - ($1 || ' days')::interval
               and not exists (
                 select 1 from "Dispute" d
                 where d."shipmentId" = s."id"
                   and d."status" in ('OPEN'::"DisputeStatus", 'IN_REVIEW'::"DisputeStatus")
               )
             limit $2::int
           ), removed as (
             delete from "ShipmentLocationPing" where "id" in (select "id" from expired) returning 1
           )
           select count(*)::int as "count" from removed`,
          String(retentionDays),
          batchSize,
        );
        const removed = Number(rows[0]?.count ?? 0);
        deleted += removed;
        if (removed < batchSize) break;
      }
    } catch (error) {
      this.logger.error(`purgeExpiredLocationHistory() failed after deleting ${deleted} rows: ${this.errorMessage(error)}`);
      throw new InternalServerErrorException('Could not purge expired location history.');
    }
    return { retentionDays, deleted, ranAt: new Date().toISOString() };
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
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new BadRequestException('A valid GPS latitude and longitude are required to record a location.');
    }

    const { recordedAt, accuracyM, clientPingId } = this.parseCaptureMetadata(input);

    // This used to echo the submitted coordinates straight back as a fake "saved" ping
    // whenever the INSERT failed - so a driver's GPS trail could silently stop being
    // recorded (DB error, connection drop) while the driver-side reporter, the pickup
    // confirmation flow, and the trip-stage-advance flow all believed every ping saved
    // fine. A location that wasn't actually saved must surface as a real error.
    let rows: LocationRow[];
    try {
      await this.ensureLocationColumns();
      rows = await this.prisma.$queryRawUnsafe(
        `insert into "ShipmentLocationPing" ("id", "shipmentId", "driverId", "latitude", "longitude", "heading", "speedKph", "note", "recordedAt", "accuracyM", "clientPingId")
         select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
         from "Shipment" s
         where s."id" = $2
           and s."status" in ('DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION')
         on conflict ("shipmentId", "clientPingId") where "clientPingId" is not null do nothing
         returning ${LOCATION_COLUMNS}`,
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
        recordedAt,
        accuracyM,
        clientPingId,
      );
      if (!rows[0] && clientPingId) {
        // Either a retry of a fix we already stored (return it - idempotent), or the
        // shipment is no longer in a tracking stage (fall through to the 409 below).
        rows = await this.prisma.$queryRawUnsafe(
          `select ${LOCATION_COLUMNS} from "ShipmentLocationPing" where "shipmentId" = $1 and "clientPingId" = $2 limit 1`,
          shipmentId,
          clientPingId,
        );
      }
    } catch (error) {
      throw new InternalServerErrorException(`Could not record this location. Please try again: ${this.errorMessage(error)}`);
    }

    if (!rows[0]) throw new ConflictException('Location sharing has ended for this shipment.');
    // Alerts compare the most recent positions, so a delayed fix drained from an offline
    // queue shouldn't trigger (or suppress) them - only evaluate for a recent one.
    const capturedAt = rows[0].recordedAt ?? rows[0].createdAt;
    if (Date.now() - capturedAt.getTime() <= ALERT_FRESHNESS_MS) {
      await this.detectTrackingAlerts(shipmentId).catch((error) => {
        this.logger.warn(`Tracking alert evaluation failed for ${shipmentId}: ${this.errorMessage(error)}`);
      });
    }
    return this.toLocation(rows[0]);
  }

  // Validates the optional capture metadata a driver app sends with a fix. Old app
  // versions send none of it, in which case the server receipt time is used as before.
  private parseCaptureMetadata(input: LocationInput) {
    let recordedAt: Date | null = null;
    if (input.recordedAt != null && input.recordedAt !== '') {
      const parsed = new Date(input.recordedAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('recordedAt must be a valid ISO timestamp.');
      }
      const age = Date.now() - parsed.getTime();
      if (age < -MAX_FUTURE_SKEW_MS) {
        throw new BadRequestException('recordedAt is in the future - check the device clock.');
      }
      if (age > MAX_PING_AGE_MS) {
        throw new BadRequestException('This location is too old to record for a live trip.');
      }
      recordedAt = parsed;
    }

    let accuracyM: number | null = null;
    if (input.accuracyM != null) {
      const accuracy = Number(input.accuracyM);
      if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) {
        throw new BadRequestException('accuracyM must be a number of metres between 0 and 100000.');
      }
      accuracyM = accuracy;
    }

    let clientPingId: string | null = null;
    if (input.clientPingId != null && input.clientPingId !== '') {
      const id = String(input.clientPingId);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
        throw new BadRequestException('clientPingId must be 8-64 letters, digits, dashes or underscores.');
      }
      clientPingId = id;
    }

    return { recordedAt, accuracyM, clientPingId };
  }

  private async detectTrackingAlerts(shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        timeline: { orderBy: { createdAt: 'asc' } },
        locationPings: { orderBy: { createdAt: 'desc' }, take: 100 },
      },
    });
    if (!shipment || shipment.status !== 'IN_TRANSIT') return;

    const inTransitAt = shipment.timeline.find((event) => event.status === 'IN_TRANSIT')?.createdAt;
    if (inTransitAt && shipment.durationMinutes) {
      const elapsedMinutes = (Date.now() - inTransitAt.getTime()) / 60_000;
      const delayThreshold = shipment.durationMinutes * 1.25;
      if (elapsedMinutes > delayThreshold) {
        await this.emitTrackingAlert({
          shipmentId,
          customerId: shipment.customerId,
          title: 'Shipment delay detected',
          body: `${shipment.reference} is ${Math.round(elapsedMinutes - shipment.durationMinutes)} minutes beyond its estimated journey time. Trako operations has been alerted.`,
          since: inTransitAt,
        });
      }
    }

    const pings = shipment.locationPings;
    if (shipment.destinationLatitude == null || shipment.destinationLongitude == null || pings.length < 3) return;
    const latest = pings[0];
    const oldest = pings[pings.length - 1];
    const observationMinutes = (latest.createdAt.getTime() - oldest.createdAt.getTime()) / 60_000;
    if (observationMinutes < 10) return;

    const latestDistance = this.distanceKm(latest.latitude, latest.longitude, shipment.destinationLatitude, shipment.destinationLongitude);
    const oldestDistance = this.distanceKm(oldest.latitude, oldest.longitude, shipment.destinationLatitude, shipment.destinationLongitude);
    const movedAwayKm = latestDistance - oldestDistance;
    if (latestDistance >= 15 && movedAwayKm >= 10) {
      await this.emitTrackingAlert({
        shipmentId,
        customerId: shipment.customerId,
        title: 'Possible route deviation',
        body: `${shipment.reference} moved about ${Math.round(movedAwayKm)} km farther from its destination over the last ${Math.round(observationMinutes)} minutes. Trako operations is checking the route.`,
        since: new Date(Date.now() - 2 * 60 * 60_000),
      });
    }
  }

  private async emitTrackingAlert(input: {
    shipmentId: string;
    customerId: string;
    title: string;
    body: string;
    since: Date;
  }) {
    const [existing] = await this.prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `select exists(
         select 1 from "Notification"
         where "entity" = 'Shipment'
           and "entityId" = $1
           and "title" = $2
           and "createdAt" >= $3
       ) as "exists"`,
      input.shipmentId,
      input.title,
      input.since,
    );
    if (existing?.exists) return;

    await Promise.all([
      this.notifications.create({
        userId: input.customerId,
        title: input.title,
        body: input.body,
        tone: 'WARNING',
        entity: 'Shipment',
        entityId: input.shipmentId,
        actionUrl: `/customer/shipment/${input.shipmentId}`,
        preferenceKey: 'liveTrackingAlerts',
      }),
      this.notifications.create({
        role: 'DISPATCHER',
        title: input.title,
        body: input.body,
        tone: 'WARNING',
        entity: 'Shipment',
        entityId: input.shipmentId,
        actionUrl: '/dispatcher/live-map',
        preferenceKey: 'liveTrackingAlerts',
      }),
    ]);
  }

  private distanceKm(fromLatitude: number, fromLongitude: number, toLatitude: number, toLongitude: number) {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = radians(toLatitude - fromLatitude);
    const longitudeDelta = radians(toLongitude - fromLongitude);
    const startLatitude = radians(fromLatitude);
    const endLatitude = radians(toLatitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
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
    let shipmentReference: string = shipmentId;
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
      shipmentReference = shipment.reference;

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
        templateKey: 'notifyTpl.customerProofSubmitted',
        vars: { reference: shipmentReference },
        tone: 'SUCCESS',
        entity: 'DeliveryProof',
        entityId: rows[0].id,
        actionUrl: `/customer/shipment/${shipmentId}`,
        preferenceKey: 'shipmentStatusUpdates',
      }),
      this.notifications.create({
        role: 'DISPATCHER',
        title: 'Delivery proof received',
        body: 'A driver submitted proof of delivery for review.',
        tone: 'INFO',
        entity: 'Shipment',
        entityId: shipmentId,
        actionUrl: `/dispatcher/shipment/${shipmentId}`,
        preferenceKey: 'shipmentStatusUpdates',
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
      throw new InternalServerErrorException('Could not load delivery proofs. Please try again.');
    }

    // This used to fabricate a "SUBMITTED" proof of delivery, signed by "Preview
    // recipient", for a shipment that had never actually been delivered - shown directly
    // to the customer on the delivery-confirmation screen. An honest empty list instead;
    // every caller already handles zero proofs correctly.
    return [];
  }

  async shipmentEvidence(shipmentId: string, user: AuthUser) {
    shipmentId = await this.assertShipmentAccess(shipmentId, user);
    try {
      const pickupPhotos = await this.prisma.$queryRawUnsafe<
        { id: string; url: string | null; label: string; createdAt: Date }[]
      >(
        `select "id", "url", "label", "createdAt"
         from "MediaAsset"
         where "shipmentId" = $1
           and "kind" = 'CARGO_PHOTO'::"MediaKind"
           and "label" like 'Pickup cargo condition%'
         order by "createdAt" asc`,
        shipmentId,
      );
      const deliveryProofs = await this.prisma.$queryRawUnsafe<
        {
          id: string;
          photoUrl: string | null;
          signatureUrl: string | null;
          recipientName: string | null;
          note: string | null;
          status: string;
          submittedAt: Date;
        }[]
      >(
        `select "id", "photoUrl", "signatureUrl", "recipientName", "note",
                "status"::text as "status", "submittedAt"
         from "DeliveryProof"
         where "shipmentId" = $1
         order by "submittedAt" desc`,
        shipmentId,
      );
      const pickupTimelineRows = await this.prisma.$queryRawUnsafe<
        { note: string | null; createdAt: Date }[]
      >(
        `select "note", "createdAt"
         from "ShipmentTimeline"
         where "shipmentId" = $1
           and "status" = 'PICKED_UP'::"ShipmentStatus"
         order by "createdAt" desc
         limit 1`,
        shipmentId,
      );
      const pickupTimeline = pickupTimelineRows[0];

      return {
        shipmentId,
        pickup: {
          note: pickupTimeline?.note ?? undefined,
          confirmedAt: pickupTimeline?.createdAt.toISOString(),
          photos: pickupPhotos
            .filter((photo) => Boolean(photo.url))
            .map((photo) => ({ ...photo, url: photo.url!, createdAt: photo.createdAt.toISOString() })),
        },
        delivery: {
          proofs: deliveryProofs.map((proof) => ({
            id: proof.id,
            photoUrl: proof.photoUrl ?? undefined,
            signatureUrl: proof.signatureUrl ?? undefined,
            recipientName: proof.recipientName ?? undefined,
            note: proof.note ?? undefined,
            status: proof.status,
            submittedAt: proof.submittedAt.toISOString(),
          })),
        },
      };
    } catch (error) {
      throw new InternalServerErrorException(`Could not load shipment evidence. Please try again: ${this.errorMessage(error)}`);
    }
  }

  private toLocation(row: LocationRow) {
    // createdAt is the moment the position was CAPTURED (falling back to arrival time for
    // older rows and app versions): existing clients already treat it as the freshness
    // timestamp, so a delayed update keeps showing its true age. receivedAt is arrival.
    const capturedAt = row.recordedAt ?? row.createdAt;
    return {
      id: row.id,
      shipmentId: row.shipmentId,
      driverId: row.driverId ?? undefined,
      latitude: row.latitude,
      longitude: row.longitude,
      heading: row.heading ?? undefined,
      speedKph: row.speedKph ?? undefined,
      accuracyM: row.accuracyM ?? undefined,
      note: row.note ?? undefined,
      createdAt: capturedAt.toISOString(),
      receivedAt: row.createdAt.toISOString(),
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

