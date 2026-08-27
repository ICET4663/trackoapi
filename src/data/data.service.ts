import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DataCollection =
  | 'customer-shipments'
  | 'wallet-transactions'
  | 'shipment-offers'
  | 'chat-threads'
  | 'verification'
  | 'owner-trucks'
  | 'driver-vehicles'
  | 'seeking-drivers'
  | 'dispatcher-shipments'
  | 'dispatcher-disputes'
  | 'platform-users'
  | 'operation-drivers'
  | 'operation-shipments'
  | 'driver-jobs'
  | 'active-trips';

// These collections return platform-wide data (every user's PII, every shipment,
// every dispute) with no per-user scoping - only ops staff may read them. Everything
// else here is already scoped to the caller's own userId inside its case branch.
const OPS_ONLY_COLLECTIONS = new Set<DataCollection>([
  'dispatcher-shipments',
  'dispatcher-disputes',
  'platform-users',
  'operation-drivers',
  'operation-shipments',
  // Unused by the frontend (real conversation listing goes through the participant-
  // scoped /v1/conversations endpoint) - gated the same way rather than left as an
  // unscoped bypass of that scoping.
  'chat-threads',
]);

// Every driver's name, phone, and location, platform-wide - legitimate for a truck
// owner browsing for drivers to hire (or ops staff), not for a bare customer/driver
// account to enumerate.
const OWNER_OR_OPS_COLLECTIONS = new Set<DataCollection>(['seeking-drivers']);

@Injectable()
export class DataService {
  constructor(private readonly prisma: PrismaService) {}

  async list(collection: DataCollection, userId: string, role: UserRole) {
    // Checked before the try block on purpose: the catch below exists to fall back to
    // preview data on a real infrastructure failure, and must never also swallow this
    // into a silent "here's some data anyway" response for someone who isn't ops staff.
    if (OPS_ONLY_COLLECTIONS.has(collection) && role !== 'ADMIN' && role !== 'DISPATCHER') {
      throw new ForbiddenException('Only platform operations can view this data.');
    }
    if (OWNER_OR_OPS_COLLECTIONS.has(collection) && !['TRUCK_OWNER', 'ADMIN', 'DISPATCHER'].includes(role)) {
      throw new ForbiddenException('Only truck owners and platform operations can view this data.');
    }
    try {
      switch (collection) {
        case 'customer-shipments':
          // `id` is the real Shipment.id (cuid) - the same id the /v1/shipments/:id/...
          // endpoints (escrow, timeline, review) expect. `reference` is the human-facing
          // TRK-... code for display only. These must not be swapped: portal.service.ts's
          // toCustomerShipment() produces this same CustomerShipment shape using the real
          // id, and the two were previously inconsistent (this list used the reference as
          // `id`), which silently broke escrow/timeline/review lookups for any shipment
          // opened via this list instead of straight from shipment creation.
          return (await this.prisma.shipment.findMany({
            where: { customerId: userId },
            orderBy: { createdAt: 'desc' },
          })).map((shipment) => ({
            id: shipment.id,
            reference: shipment.reference,
            status: shipment.status,
            date: shipment.createdAt.toLocaleString('en-US', { day: '2-digit' }),
            month: shipment.createdAt.toLocaleString('en-US', { month: 'short' }).toUpperCase(),
            origin: shipment.pickupLabel,
            destination: shipment.destinationLabel,
            commodity: shipment.cargoDescription,
            amount: this.formatMoney(shipment.quotedPriceKobo),
            meta: shipment.distanceKm ? `${shipment.distanceKm.toFixed(1)} km route` : shipment.pickupAddress,
          }));
        case 'owner-trucks':
          // The raw Vehicle row doesn't match the frontend's OwnerTruck shape (reg/
          // capacity/status/documents vs plateNumber/capacityKg/isActive) - every real
          // registered truck was rendering with those fields blank. Mapped explicitly
          // below. `documents`/`year` have no backing column yet (no vehicle-document
          // tracking exists), so they get an honest neutral value rather than a fake
          // "Verified" - this is the one input this collection cannot get right until
          // that tracking is built.
          return (await this.prisma.vehicle.findMany({
            where: { ownerId: userId },
            include: { assignedDriver: { include: { profile: true } } },
            orderBy: { createdAt: 'desc' },
          })).map((vehicle) => ({
            id: vehicle.id,
            reg: vehicle.plateNumber,
            type: vehicle.type,
            capacity: vehicle.capacityKg ? `${(vehicle.capacityKg / 1000).toFixed(1)}t` : 'Capacity pending',
            year: '—',
            status: vehicle.assignedDriverId ? 'Assigned' : vehicle.isActive ? 'Available' : 'Maintenance',
            base: vehicle.registrationState ?? 'Location pending',
            assignedDriver: vehicle.assignedDriver?.profile?.fullName ?? vehicle.assignedDriver?.email,
            documents: 'Incomplete',
          }));
        case 'driver-vehicles':
          // The truck(s) this driver is currently assigned to drive - not the owner's
          // full fleet.
          return (await this.prisma.vehicle.findMany({
            where: { assignedDriverId: userId },
            include: { owner: { include: { profile: true } } },
            orderBy: { updatedAt: 'desc' },
          })).map((vehicle) => ({
            id: vehicle.id,
            reg: vehicle.plateNumber,
            type: vehicle.type,
            capacity: vehicle.capacityKg ? `${(vehicle.capacityKg / 1000).toFixed(1)}t` : 'Capacity pending',
            status: vehicle.isActive ? 'Active' : 'Inactive',
            owner: vehicle.owner.profile?.fullName ?? vehicle.owner.email,
          }));
        case 'driver-jobs':
        case 'active-trips':
          return await this.prisma.driverAssignment.findMany({
            where: {
              driverId: userId,
              status: collection === 'driver-jobs' ? 'OFFERED' : 'ACCEPTED',
            },
            include: { shipment: true, vehicle: true },
            orderBy: { offeredAt: 'desc' },
          }).then((assignments) => assignments.map((assignment) => ({
            id: assignment.id,
            shipmentDbId: assignment.shipment.id,
            shipmentId: assignment.shipment.reference,
            origin: assignment.shipment.pickupLabel,
            destination: assignment.shipment.destinationLabel,
            cargo: assignment.shipment.cargoDescription,
            price: this.formatMoney(assignment.shipment.quotedPriceKobo),
            status: assignment.status,
            truck: assignment.vehicle?.plateNumber ?? 'Truck pending',
            sender: 'Tracko customer',
            senderInitial: 'TC',
            receiver: assignment.shipment.destinationLabel,
            distance: assignment.shipment.distanceKm ? `${assignment.shipment.distanceKm.toFixed(1)} km` : 'Route pending',
            eta: assignment.shipment.durationMinutes ? `${assignment.shipment.durationMinutes} mins` : 'ETA pending',
            stageIndex: this.stageIndex(assignment.shipment.status),
            completed: ['DELIVERED', 'COMPLETED'].includes(assignment.shipment.status),
          })));
        case 'chat-threads':
          return await this.prisma.conversation.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 });
        case 'wallet-transactions':
          return await this.walletTransactions(userId);
        case 'shipment-offers':
          return await this.shipmentOffers(userId);
        case 'verification':
          return await this.verificationSummary(userId);
        case 'seeking-drivers':
          return await this.seekingDrivers();
        case 'dispatcher-shipments':
          return await this.dispatcherShipments();
        case 'dispatcher-disputes':
          return await this.dispatcherDisputes();
        case 'platform-users':
          return await this.platformUsers();
        case 'operation-drivers':
          return await this.operationDrivers();
        case 'operation-shipments':
          return await this.operationShipments();
        default:
          throw new BadRequestException('Unsupported data collection.');
      }
    } catch {
      return this.previewList(collection);
    }
  }

  async item(collection: DataCollection, id: string, userId: string, role: UserRole) {
    const items = await this.list(collection, userId, role);
    return items.find((item: { id: string }) => item.id === id) ?? { id };
  }

  async create(collection: DataCollection, item: Record<string, unknown>, userId: string) {
    try {
      switch (collection) {
        case 'customer-shipments':
          return await this.prisma.shipment.create({
            data: {
              reference: `TRK-${Date.now()}`,
              customerId: userId,
              pickupLabel: String(item.pickupLabel ?? item.origin ?? 'Pickup'),
              pickupAddress: String(item.pickupAddress ?? item.origin ?? 'Pickup address'),
              destinationLabel: String(item.destinationLabel ?? item.destination ?? 'Destination'),
              destinationAddress: String(item.destinationAddress ?? item.destination ?? 'Destination address'),
              cargoDescription: String(item.cargoDescription ?? item.commodity ?? 'Cargo'),
            },
          });
        case 'owner-trucks': {
          // register-truck.tsx tells the owner "saved to the backend fleet database" -
          // the default branch below only ever echoed the submitted form fields back
          // with a local id and never wrote a Vehicle row, so that message was false
          // and the truck vanished on reload.
          const plateNumber = String(item.reg ?? item.plateNumber ?? '').trim().toUpperCase();
          if (!plateNumber) throw new BadRequestException('A registration/plate number is required.');
          const vehicle = await this.prisma.vehicle.create({
            data: {
              ownerId: userId,
              plateNumber,
              type: String(item.type ?? 'Flatbed'),
              capacityKg: this.parseCapacityKg(item.capacity),
              registrationState: item.base ? String(item.base) : null,
            },
          });
          return {
            id: vehicle.id,
            reg: vehicle.plateNumber,
            type: vehicle.type,
            capacity: vehicle.capacityKg ? `${(vehicle.capacityKg / 1000).toFixed(1)}t` : 'Capacity pending',
            year: '—',
            status: 'Available',
            base: vehicle.registrationState ?? 'Location pending',
            documents: 'Incomplete',
          };
        }
        default:
          return { ...item, id: String(item.id ?? `local_${Date.now()}`) };
      }
    } catch {
      return { ...item, id: String(item.id ?? `local_${Date.now()}`), preview: true };
    }
  }

  private async dispatcherShipments() {
    const shipments = await this.prisma.shipment.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const customerIds = [...new Set(shipments.map((shipment) => shipment.customerId))];
    const shipmentIds = shipments.map((shipment) => shipment.id);
    const [customers, assignments] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: customerIds } }, include: { profile: true } }),
      this.prisma.driverAssignment.findMany({
        where: { shipmentId: { in: shipmentIds } },
        include: { driver: { include: { profile: true } }, vehicle: true },
        orderBy: { offeredAt: 'desc' },
      }),
    ]);
    const customersById = new Map(customers.map((customer) => [customer.id, customer]));
    const assignmentsByShipment = new Map(assignments.map((assignment) => [assignment.shipmentId, assignment]));

    return shipments.map((shipment) => {
      const assignment = assignmentsByShipment.get(shipment.id);
      const customer = customersById.get(shipment.customerId);
      return {
        id: shipment.reference,
        route: `${shipment.pickupLabel} to ${shipment.destinationLabel}`,
        cargo: shipment.cargoDescription,
        status: this.dispatcherStatus(shipment.status),
        state: shipment.status.replaceAll('_', ' '),
        driver: assignment?.driver.profile?.fullName ?? assignment?.driver.email,
        customer: customer?.profile?.fullName ?? customer?.email ?? 'Tracko customer',
        amount: this.formatMoney(shipment.quotedPriceKobo),
        pickup: shipment.pickupAddress,
        destination: shipment.destinationAddress,
      };
    });
  }

  private async dispatcherDisputes() {
    type DisputeRow = {
      id: string;
      shipmentId: string;
      reference: string;
      pickupLabel: string;
      destinationLabel: string;
      reason: string;
      description: string | null;
      priority: string;
      status: string;
      updatedAt: Date | string;
    };
    type LegacyShipmentRow = {
      id: string;
      reference: string;
      pickupLabel: string;
      destinationLabel: string;
      updatedAt: Date | string;
    };

    const [disputes, legacyShipments] = await Promise.all([
      this.prisma.$queryRawUnsafe<DisputeRow[]>(
        `select d."id", d."shipmentId", d."reason", d."description", d."priority",
                d."status"::text as "status", d."updatedAt",
                s."reference", s."pickupLabel", s."destinationLabel"
         from "Dispute" d
         join "Shipment" s on s."id" = d."shipmentId"
         order by d."updatedAt" desc
         limit 100`,
      ),
      this.prisma.$queryRawUnsafe<LegacyShipmentRow[]>(
        `select s."id", s."reference", s."pickupLabel", s."destinationLabel", s."updatedAt"
         from "Shipment" s
         where s."status" = 'DISPUTED'::"ShipmentStatus"
           and not exists (select 1 from "Dispute" d where d."shipmentId" = s."id")
         order by s."updatedAt" desc
         limit 100`,
      ),
    ]);

    const records = disputes.map((dispute) => ({
      id: dispute.id,
      shipmentId: dispute.reference,
      category: /payment|escrow|refund/i.test(dispute.reason) ? 'Payment' : /late|delay/i.test(dispute.reason) ? 'Late delivery' : 'Delivery issue',
      title: dispute.reason,
      reason: dispute.reason,
      description: dispute.description ?? undefined,
      priority: dispute.priority,
      summary: `${dispute.pickupLabel} to ${dispute.destinationLabel}`,
      age: this.ageLabel(new Date(dispute.updatedAt)),
      status: ['RESOLVED', 'REJECTED'].includes(dispute.status) ? 'Resolved' : dispute.status === 'IN_REVIEW' ? 'Escalated' : 'Open',
    }));

    return records.concat(legacyShipments.map((shipment) => ({
      id: `legacy-${shipment.id}`,
      shipmentId: shipment.reference,
      category: 'Delivery issue',
      title: 'Shipment marked as disputed',
      reason: 'Legacy delivery dispute',
      description: undefined,
      priority: 'MEDIUM',
      summary: `${shipment.pickupLabel} to ${shipment.destinationLabel}`,
      age: this.ageLabel(new Date(shipment.updatedAt)),
      status: 'Open',
    })));
  }

  private async platformUsers() {
    const users = await this.prisma.user.findMany({
      include: { profile: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return users.map((user) => ({
      id: user.id,
      name: user.profile?.fullName ?? user.email,
      role: this.displayRole(user.role),
      status: user.isActive ? (user.verificationStatus === 'VERIFIED' ? 'Active' : 'Pending') : 'Suspended',
      phone: user.phone,
      email: user.email,
      joined: user.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      trust: user.verificationStatus === 'VERIFIED' ? 96 : 62,
      location: [user.profile?.city, user.profile?.state].filter(Boolean).join(', ') || user.profile?.address || 'Location pending',
    }));
  }

  private async operationDrivers() {
    const drivers = await this.prisma.user.findMany({
      where: { OR: [{ role: UserRole.DRIVER }, { availableRoles: { has: UserRole.DRIVER } }] },
      include: {
        profile: true,
        driverVehicles: true,
        driverAssignments: { include: { shipment: true }, orderBy: { offeredAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return drivers.map((driver) => {
      const vehicle = driver.driverVehicles[0];
      const activeAssignment = driver.driverAssignments.find((assignment) => assignment.status === 'ACCEPTED');
      return {
        id: driver.id,
        name: driver.profile?.fullName ?? driver.email,
        status: activeAssignment ? 'Active' : driver.isActive ? 'Inactive' : 'Delayed',
        truck: vehicle?.type ?? 'Truck pending',
        plate: vehicle?.plateNumber ?? 'Unassigned',
        phone: driver.phone,
        rating: driver.verificationStatus === 'VERIFIED' ? '4.8' : 'New',
        latitude: activeAssignment?.shipment.pickupLatitude ?? 6.5244,
        longitude: activeAssignment?.shipment.pickupLongitude ?? 3.3792,
      };
    });
  }

  private async operationShipments() {
    const shipments = await this.prisma.shipment.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const assignments = await this.prisma.driverAssignment.findMany({
      where: { shipmentId: { in: shipments.map((shipment) => shipment.id) } },
      orderBy: { offeredAt: 'desc' },
    });
    const assignmentsByShipment = new Map(assignments.map((assignment) => [assignment.shipmentId, assignment]));

    return shipments.map((shipment) => {
      const assignment = assignmentsByShipment.get(shipment.id);
      return {
        id: shipment.reference,
        driverId: assignment?.driverId ?? '',
        customerId: shipment.customerId,
        status: this.operationStatus(shipment.status),
        pickup: shipment.pickupAddress,
        destination: shipment.destinationAddress,
        cargo: shipment.cargoDescription,
        amount: this.formatMoney(shipment.quotedPriceKobo),
        updated: shipment.updatedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      };
    });
  }

  private async seekingDrivers() {
    const drivers = await this.prisma.user.findMany({
      where: { OR: [{ role: UserRole.DRIVER }, { availableRoles: { has: UserRole.DRIVER } }], isActive: true },
      include: { profile: true, driverVehicles: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return drivers.map((driver) => {
      const vehicle = driver.driverVehicles[0];
      return {
        id: driver.id,
        name: driver.profile?.fullName ?? driver.email,
        rating: driver.verificationStatus === 'VERIFIED' ? 5 : 4,
        location: [driver.profile?.city, driver.profile?.state].filter(Boolean).join(', ') || 'Location pending',
        truck: vehicle?.type ?? 'Truck pending',
        plate: vehicle?.plateNumber ?? 'Unassigned',
        phone: driver.phone,
      };
    });
  }

  private async shipmentOffers(userId: string) {
    const assignments = await this.prisma.driverAssignment.findMany({
      where: { OR: [{ driverId: userId }, { shipment: { customerId: userId } }] },
      include: { shipment: true, vehicle: true, driver: { include: { profile: true } } },
      orderBy: { offeredAt: 'desc' },
      take: 100,
    });

    return assignments.map((assignment) => ({
      id: assignment.id,
      shipmentId: assignment.shipment.reference,
      driver: assignment.driver.profile?.fullName ?? assignment.driver.email,
      truck: assignment.vehicle?.plateNumber ?? 'Truck pending',
      origin: assignment.shipment.pickupLabel,
      destination: assignment.shipment.destinationLabel,
      amount: this.formatMoney(assignment.shipment.quotedPriceKobo),
      status: assignment.status,
    }));
  }

  private async walletTransactions(userId: string) {
    const shipments = await this.prisma.shipment.findMany({
      where: { customerId: userId, quotedPriceKobo: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return shipments.map((shipment) => {
      const status = shipment.status === 'COMPLETED' ? 'RELEASED' : shipment.status === 'CANCELLED' ? 'REFUNDED' : 'HELD';
      const route = `${shipment.pickupLabel} to ${shipment.destinationLabel}`;
      const reference = `ESC-${shipment.reference}`;

      return {
        id: `wallet-${shipment.reference}`,
        title: `Shipment escrow - ${shipment.reference}`,
        subtitle: route,
        amount: this.formatMoney(shipment.quotedPriceKobo),
        icon: status === 'RELEASED' ? 'south-west' : status === 'REFUNDED' ? 'add' : 'lock',
        tone: status === 'RELEASED' || status === 'REFUNDED' ? 'in' : 'hold',
        type: 'DEBIT',
        date: shipment.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        status,
        shipmentId: shipment.reference,
        reference,
        method: 'Paystack escrow',
        category: 'Shipment escrow',
        counterparty: route,
        timelineNote: this.walletTimelineNote(status),
        description: this.walletDescription(status, shipment.reference),
      };
    });
  }

  private walletTimelineNote(status: string) {
    if (status === 'RELEASED') return 'Funds released after delivery confirmation.';
    if (status === 'REFUNDED') return 'Funds returned after shipment cancellation.';
    return 'Funds are held in escrow until delivery is confirmed.';
  }

  private walletDescription(status: string, reference: string) {
    if (status === 'RELEASED') return `Escrow for ${reference} has been approved and released to payout processing.`;
    if (status === 'REFUNDED') return `Escrow for ${reference} was cancelled and marked for refund.`;
    return `Escrow for ${reference} is protected while pickup, delivery proof, and customer confirmation are completed.`;
  }

  private async verificationSummary(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    return user
      ? [{
          id: user.id,
          status: user.verificationStatus,
          submissionStatus: user.verificationStatus === 'VERIFIED' ? 'APPROVED' : 'PENDING',
          submittedAt: null,
        }]
      : [];
  }

  private displayRole(role: UserRole) {
    switch (role) {
      case UserRole.DRIVER:
        return 'Driver';
      case UserRole.DISPATCHER:
        return 'Dispatcher';
      case UserRole.ADMIN:
        return 'Administrator';
      default:
        return 'Customer';
    }
  }

  private dispatcherStatus(status: string) {
    if (['IN_TRANSIT', 'PICKED_UP', 'DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'ARRIVED_DESTINATION'].includes(status)) return 'In transit';
    if (status === 'DISPUTED') return 'Delayed';
    return 'Posted';
  }

  private operationStatus(status: string) {
    if (['DELIVERED', 'COMPLETED'].includes(status)) return 'Delivered';
    if (status === 'CANCELLED') return 'Cancelled';
    if (status === 'DISPUTED') return 'Delayed';
    return 'In transit';
  }

  private stageIndex(status: string) {
    if (['ARRIVED_PICKUP'].includes(status)) return 1;
    if (['PICKED_UP', 'IN_TRANSIT'].includes(status)) return 2;
    if (['ARRIVED_DESTINATION'].includes(status)) return 3;
    if (['DELIVERED', 'COMPLETED'].includes(status)) return 4;
    return 0;
  }

  private formatMoney(amountKobo?: number | null) {
    if (!amountKobo) return 'N0';
    return `N${Math.round(amountKobo / 100).toLocaleString('en-US')}`;
  }

  // Owners type free text like "30 tons" or "12000 kg" into the capacity field - pull
  // the leading number out and assume tons unless "kg" is explicitly present.
  private parseCapacityKg(input: unknown): number | null {
    const raw = String(input ?? '').trim().toLowerCase();
    const match = raw.match(/[\d.]+/);
    if (!match) return null;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return raw.includes('kg') ? Math.round(value) : Math.round(value * 1000);
  }

  private ageLabel(date: Date) {
    const hours = Math.max(1, Math.round((Date.now() - date.getTime()) / 36e5));
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  private previewList(collection: DataCollection) {
    switch (collection) {
      case 'active-trips':
        return [
          {
            id: 'TRK-1024',
            sender: 'Tracko Customer',
            senderInitial: 'TC',
            receiver: 'Abuja Receiver',
            origin: 'Lagos',
            destination: 'Abuja',
            cargo: 'Consumer goods',
            distance: '752 km',
            eta: 'Today, 6:30 PM',
            stageIndex: 2,
            completed: false,
          },
        ];
      case 'customer-shipments':
        return [
          {
            id: 'TRK-1024',
            reference: 'TRK-1024',
            status: 'IN_TRANSIT',
            date: '22',
            month: 'JUL',
            origin: 'Lagos',
            destination: 'Abuja',
            commodity: 'Consumer goods',
            amount: 'N240,000',
            meta: 'Preview shipment',
          },
        ];
      case 'owner-trucks':
        return [
          {
            id: 'truck-1',
            reg: 'LAG-204-TK',
            type: 'Flatbed',
            capacity: '30 tons',
            year: '2021',
            status: 'Available',
            base: 'Lagos',
            documents: 'Verified',
          },
        ];
      case 'driver-jobs':
        return [
          {
            id: 'job-1',
            origin: 'Lagos',
            destination: 'Abuja',
            cargo: 'Consumer goods',
            price: 'N240,000',
            status: 'OFFERED',
          },
        ];
      case 'dispatcher-shipments':
      case 'operation-shipments':
        return [
          {
            id: 'TRK-1024',
            status: 'IN_TRANSIT',
            origin: 'Lagos',
            destination: 'Abuja',
            customer: 'Tracko Customer',
            driver: 'Musa Ibrahim',
            truck: 'LAG-204-TK',
            eta: 'Today, 6:30 PM',
          },
        ];
      case 'dispatcher-disputes':
        return [
          {
            id: 'DSP-1001',
            title: 'Delivery confirmation pending',
            status: 'OPEN',
            priority: 'Medium',
          },
        ];
      case 'platform-users':
        return [
          {
            id: 'preview-customer',
            name: 'Tracko Customer',
            role: 'CUSTOMER',
            status: 'VERIFIED',
            email: 'customer@tracko.ng',
            phone: '+234 800 000 0000',
          },
          {
            id: 'preview-driver',
            name: 'Musa Ibrahim',
            role: 'DRIVER',
            status: 'VERIFIED',
            email: 'driver@tracko.ng',
            phone: '+234 800 000 0001',
          },
        ];
      case 'operation-drivers':
        return [
          {
            id: 'preview-driver',
            name: 'Musa Ibrahim',
            status: 'ONLINE',
            location: 'Lagos',
            rating: 5,
          },
        ];
      case 'wallet-transactions':
        return [
          {
            id: 'wallet-1',
            title: 'Escrow hold',
            amount: 'N240,000',
            type: 'DEBIT',
            date: 'Jul 22, 2026',
            status: 'HELD',
          },
        ];
      case 'seeking-drivers':
        return [
          {
            id: 'driver-match-1',
            name: 'Musa Ibrahim',
            rating: 5,
            location: 'Lagos',
            truck: 'Flatbed',
          },
        ];
      default:
        return [];
    }
  }
}
