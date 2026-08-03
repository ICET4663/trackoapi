import { BadRequestException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type DataCollection =
  | 'customer-shipments'
  | 'wallet-transactions'
  | 'shipment-offers'
  | 'chat-threads'
  | 'verification'
  | 'owner-trucks'
  | 'seeking-drivers'
  | 'dispatcher-shipments'
  | 'dispatcher-disputes'
  | 'platform-users'
  | 'operation-drivers'
  | 'operation-shipments'
  | 'driver-jobs'
  | 'active-trips';

@Injectable()
export class DataService {
  constructor(private readonly prisma: PrismaService) {}

  async list(collection: DataCollection, userId: string) {
    try {
      switch (collection) {
        case 'customer-shipments':
          return (await this.prisma.shipment.findMany({
            where: { customerId: userId },
            orderBy: { createdAt: 'desc' },
          })).map((shipment) => ({
            id: shipment.reference,
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
          return await this.prisma.vehicle.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'desc' } });
        case 'driver-jobs':
        case 'active-trips':
          return await this.prisma.driverAssignment.findMany({
            where: { driverId: userId },
            include: { shipment: true, vehicle: true },
            orderBy: { offeredAt: 'desc' },
          }).then((assignments) => assignments.map((assignment) => ({
            id: assignment.id,
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

  async item(collection: DataCollection, id: string, userId: string) {
    const items = await this.list(collection, userId);
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
    const shipments = await this.prisma.shipment.findMany({
      where: { status: 'DISPUTED' },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return shipments.map((shipment) => ({
      id: `dispute-${shipment.reference}`,
      shipmentId: shipment.reference,
      category: 'Shipment issue',
      title: 'Shipment marked as disputed',
      summary: `${shipment.pickupLabel} to ${shipment.destinationLabel}`,
      age: this.ageLabel(shipment.updatedAt),
      status: 'Open',
    }));
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

    return shipments.map((shipment) => ({
      id: `wallet-${shipment.reference}`,
      title: `Shipment escrow - ${shipment.reference}`,
      amount: this.formatMoney(shipment.quotedPriceKobo),
      type: 'DEBIT',
      date: shipment.updatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      status: shipment.status === 'COMPLETED' ? 'RELEASED' : shipment.status === 'CANCELLED' ? 'REFUNDED' : 'HELD',
      shipmentId: shipment.reference,
    }));
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
    const stages = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_DESTINATION', 'DELIVERED', 'COMPLETED'];
    return Math.max(0, stages.indexOf(status));
  }

  private formatMoney(amountKobo?: number | null) {
    if (!amountKobo) return 'N0';
    return `N${Math.round(amountKobo / 100).toLocaleString('en-US')}`;
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
