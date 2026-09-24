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

  async customer(userId: string) {
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

  async driver(userId: string) {
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

  async owner(userId: string) {
    const [user, drivers] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          profile: true,
          vehicles: {
            include: {
              documents: true,
              assignedDriver: { include: { profile: true } },
              assignments: {
                where: { status: { in: ['OFFERED', 'ACCEPTED'] } },
                include: { shipment: true, driver: { include: { profile: true } } },
                orderBy: { offeredAt: 'desc' },
                take: 20,
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
          },
        },
      }),
      this.prisma.user.findMany({
        where: { role: 'DRIVER', isActive: true, verificationStatus: 'VERIFIED' },
        include: {
          profile: true,
          driverVehicles: { where: { isActive: true }, take: 1 },
          driverAssignments: {
            include: { shipment: true, vehicle: true },
            orderBy: { offeredAt: 'desc' },
            take: 100,
          },
          driverReviews: { select: { rating: true }, take: 100 },
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    ]);

    const trucks = user?.vehicles ?? [];
    const mappedTrucks = trucks.map((truck) => ({
      id: truck.id,
      reg: truck.plateNumber,
      type: truck.type,
      capacity: truck.capacityKg ? `${(truck.capacityKg / 1000).toFixed(1)}t` : 'Capacity pending',
      volumeCapacity: truck.capacityM3 ? `${truck.capacityM3.toFixed(1)}m³` : 'Volume pending',
      year: '—',
      status: truck.assignedDriverId ? 'Assigned' : 'Available',
      base: truck.registrationState ?? 'Not set',
      assignedDriver: truck.assignedDriver?.profile?.fullName ?? truck.assignedDriver?.email,
      documents: this.vehicleDocumentsReady(truck.documents)
        ? 'Verified'
        : truck.documents.some((document) => document.state === 'PENDING_REVIEW')
          ? 'Pending review'
          : truck.documents.some((document) => document.state === 'REJECTED')
            ? 'Action required'
            : 'Incomplete',
    }));

    const activeLoads = trucks.flatMap((truck) => truck.assignments
      .filter((assignment) => !['COMPLETED', 'CANCELLED'].includes(assignment.shipment.status))
      .map((assignment) => ({
        assignmentId: assignment.id,
        shipmentId: assignment.shipment.id,
        reference: assignment.shipment.reference,
        truckId: truck.id,
        truck: truck.plateNumber,
        driverId: assignment.driverId,
        driver: assignment.driver.profile?.fullName ?? assignment.driver.email,
        assignmentStatus: assignment.status,
        shipmentStatus: assignment.shipment.status,
        origin: assignment.shipment.pickupLabel,
        destination: assignment.shipment.destinationLabel,
        amount: money(assignment.shipment.quotedPriceKobo),
      })));
    const seekingDrivers = drivers.map((driver) => {
      const vehicle = driver.driverVehicles[0];
      const activeAssignment = driver.driverAssignments.find((assignment) =>
        assignment.status === 'ACCEPTED'
        && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(assignment.shipment.status),
      ) ?? driver.driverAssignments.find((assignment) =>
        assignment.status === 'OFFERED'
        && !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(assignment.shipment.status),
      );
      const completedAssignments = driver.driverAssignments.filter((assignment) => assignment.shipment.status === 'COMPLETED');
      const averageRating = driver.driverReviews.length
        ? driver.driverReviews.reduce((total, review) => total + review.rating, 0) / driver.driverReviews.length
        : 0;
      const state = driver.profile?.state ?? 'State pending';
      const location = [driver.profile?.city, driver.profile?.state].filter(Boolean).join(', ') || 'Location pending';
      const previousShipment = completedAssignments[0]?.shipment;
      const neededTruck = ['Flatbed', 'Box truck', 'Tanker', 'Tipper'].includes(vehicle?.type ?? '')
        ? vehicle!.type
        : 'Flatbed';
      return {
        id: driver.id,
        name: driver.profile?.fullName ?? driver.email,
        location,
        state,
        experienceYears: Math.max(0, Math.floor(completedAssignments.length / 20)),
        rating: averageRating,
        completedTrips: completedAssignments.length,
        safetyScore: 95,
        neededTruck,
        availability: activeAssignment
          ? `${activeAssignment.status === 'ACCEPTED' ? 'On trip' : 'Offer pending'} · ${activeAssignment.shipment.reference}`
          : 'Ready today',
        listedMinutes: Math.max(0, Math.floor((Date.now() - driver.updatedAt.getTime()) / 60_000)),
        previousRoute: previousShipment
          ? `${previousShipment.pickupLabel} to ${previousShipment.destinationLabel}`
          : 'No completed route yet',
        preferredRoutes: state === 'State pending' ? [] : [state],
        phone: driver.phone ?? 'Phone pending',
        verified: true,
        notes: vehicle ? `${vehicle.type} ${vehicle.plateNumber}` : 'Waiting for a verified truck assignment.',
        assignedTruckId: vehicle?.id ?? null,
        assignedTruck: vehicle?.plateNumber ?? null,
        activeShipmentReference: activeAssignment?.shipment.reference ?? null,
        canReceiveTruck: !activeAssignment,
      };
    });

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
        driverPool: seekingDrivers.length,
        documentsDue: trucks.filter((truck) => !this.vehicleDocumentsReady(truck.documents)).length,
      },
      trucks: mappedTrucks,
      availableTrucks: mappedTrucks.filter((truck) => truck.status === 'Available'),
      seekingDrivers,
      activeLoads,
    };
  }

  private vehicleDocumentsReady(documents: Array<{ type: string; state: string; expires: Date | null }>) {
    const required = ['REGISTRATION', 'INSURANCE', 'ROADWORTHINESS'];
    const now = Date.now();
    return required.every((type) => documents.some((document) =>
      document.type === type
      && document.state === 'VERIFIED'
      && (!document.expires || document.expires.getTime() > now),
    ));
  }

  private toCustomerShipment(shipment: {
    id: string;
    reference: string;
    status: string;
    createdAt: Date;
    pickupLabel: string;
    destinationLabel: string;
    cargoDescription: string;
    quantity: string | null;
    truckType: string | null;
    cargoWeightKg: number | null;
    cargoVolumeM3: number | null;
    quotedPriceKobo: number | null;
  }) {
    const month = shipment.createdAt.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    return {
      id: shipment.id,
      reference: shipment.reference,
      status: shipment.status,
      date: String(shipment.createdAt.getDate()).padStart(2, '0'),
      month,
      origin: shipment.pickupLabel,
      destination: shipment.destinationLabel,
      commodity: shipment.cargoDescription,
      quantity: shipment.quantity ?? (shipment.cargoWeightKg ? `${shipment.cargoWeightKg} kg` : '1 truckload'),
      weightTons: shipment.cargoWeightKg ? shipment.cargoWeightKg / 1000 : 0,
      volumeM3: shipment.cargoVolumeM3 ?? 0,
      truckType: shipment.truckType ?? 'Truck',
      amount: money(shipment.quotedPriceKobo),
      meta: [shipment.quantity, shipment.truckType].filter(Boolean).join(' · ') || 'Shipment load',
    };
  }
}
