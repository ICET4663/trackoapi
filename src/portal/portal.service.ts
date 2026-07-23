import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function money(kobo?: number | null) {
  const naira = Math.round((kobo ?? 0) / 100);
  return `N${new Intl.NumberFormat('en-NG').format(naira)}`;
}

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService) {}

  async customer(userId?: string) {
    if (!userId) return this.previewCustomer();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        customerShipments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    const shipments = user?.customerShipments ?? [];
    const activeShipment = shipments.find((shipment) => !['COMPLETED', 'CANCELLED'].includes(shipment.status)) ?? null;

    return {
      greetingName: user?.profile?.fullName?.split(' ')[0] ?? 'Customer',
      metrics: {
        totalShipments: shipments.length,
        activeShipments: shipments.filter((shipment) => !['COMPLETED', 'CANCELLED'].includes(shipment.status)).length,
        escrowHolds: shipments.filter((shipment) => shipment.status === 'ESCROW_FUNDED').length,
        walletBalance: money(0),
      },
      activeShipment: activeShipment ? this.toCustomerShipment(activeShipment) : null,
      recentShipments: shipments.map((shipment) => this.toCustomerShipment(shipment)),
      walletTransactions: [],
    };
  }

  async driver(userId?: string) {
    if (!userId) return this.previewDriver();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        driverAssignments: {
          include: { shipment: true, vehicle: true },
          orderBy: { offeredAt: 'desc' },
          take: 20,
        },
      },
    });

    const assignments = user?.driverAssignments ?? [];

    return {
      driver: {
        id: userId,
        name: user?.profile?.fullName ?? 'Driver',
        initials: initials(user?.profile?.fullName ?? 'Driver'),
        online: true,
        todayEarnings: money(0),
      },
      metrics: {
        availableJobs: assignments.filter((assignment) => assignment.status === 'OFFERED').length,
        activeTrips: assignments.filter((assignment) => assignment.status === 'ACCEPTED').length,
        completedTrips: assignments.filter((assignment) => assignment.shipment.status === 'COMPLETED').length,
        rating: 5,
      },
      jobs: assignments.map((assignment) => ({
        id: assignment.id,
        shipmentId: assignment.shipmentId,
        origin: assignment.shipment.pickupLabel,
        destination: assignment.shipment.destinationLabel,
        cargo: assignment.shipment.cargoDescription,
        truck: assignment.vehicle?.type ?? 'Truck',
        distance: `${assignment.shipment.distanceKm ?? 0} km`,
        distanceKm: assignment.shipment.distanceKm ?? 0,
        pickup: assignment.shipment.createdAt.toISOString(),
        price: money(assignment.shipment.quotedPriceKobo),
        km: `${assignment.shipment.distanceKm ?? 0}km`,
        status: assignment.status,
      })),
      activeTrips: assignments.filter((assignment) => assignment.status === 'ACCEPTED'),
    };
  }

  async owner(userId?: string) {
    if (!userId) return this.previewOwner();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: true,
        vehicles: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    const trucks = user?.vehicles ?? [];
    const mappedTrucks = trucks.map((truck) => ({
      id: truck.id,
      reg: truck.plateNumber,
      type: truck.type,
      capacity: truck.capacityKg ? `${truck.capacityKg}kg` : 'Not set',
      year: 'Not set',
      status: truck.assignedDriverId ? 'Assigned' : 'Available',
      base: truck.registrationState ?? 'Not set',
      assignedDriver: truck.assignedDriverId ?? undefined,
      documents: 'Verified',
    }));

    return {
      owner: {
        id: userId,
        name: user?.profile?.fullName ?? 'Fleet Owner',
        initials: initials(user?.profile?.fullName ?? 'Fleet Owner'),
      },
      metrics: {
        registeredTrucks: trucks.length,
        assignedTrucks: trucks.filter((truck) => truck.assignedDriverId).length,
        availableTrucks: trucks.filter((truck) => !truck.assignedDriverId).length,
        driverPool: 0,
        documentsDue: 0,
      },
      trucks: mappedTrucks,
      availableTrucks: mappedTrucks.filter((truck) => truck.status === 'Available'),
      seekingDrivers: [],
    };
  }

  private toCustomerShipment(shipment: {
    id: string;
    status: string;
    createdAt: Date;
    pickupLabel: string;
    destinationLabel: string;
    cargoDescription: string;
    quotedPriceKobo: number | null;
  }) {
    const month = shipment.createdAt.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    return {
      id: shipment.id,
      status: shipment.status,
      date: String(shipment.createdAt.getDate()).padStart(2, '0'),
      month,
      origin: shipment.pickupLabel,
      destination: shipment.destinationLabel,
      commodity: shipment.cargoDescription,
      amount: money(shipment.quotedPriceKobo),
      meta: 'Backend shipment',
    };
  }

  private previewCustomer() {
    const recentShipments = [
      {
        id: 'TRK-1024',
        status: 'IN_TRANSIT',
        date: '21',
        month: 'JUL',
        origin: 'Lagos',
        destination: 'Abuja',
        commodity: 'Consumer goods',
        amount: 'N240,000',
        meta: 'Preview shipment',
      },
    ];

    return {
      greetingName: 'Customer',
      metrics: {
        totalShipments: 1,
        activeShipments: 1,
        escrowHolds: 0,
        walletBalance: 'N0',
      },
      activeShipment: recentShipments[0],
      recentShipments,
      walletTransactions: [],
    };
  }

  private previewDriver() {
    return {
      driver: {
        id: 'preview-driver',
        name: 'Preview Driver',
        initials: 'PD',
        online: true,
        todayEarnings: 'N0',
      },
      metrics: {
        availableJobs: 1,
        activeTrips: 0,
        completedTrips: 0,
        rating: 5,
      },
      jobs: [],
      activeTrips: [],
    };
  }

  private previewOwner() {
    return {
      owner: {
        id: 'preview-owner',
        name: 'Preview Fleet Owner',
        initials: 'PO',
      },
      metrics: {
        registeredTrucks: 0,
        assignedTrucks: 0,
        availableTrucks: 0,
        driverPool: 0,
        documentsDue: 0,
      },
      trucks: [],
      availableTrucks: [],
      seekingDrivers: [],
    };
  }
}
