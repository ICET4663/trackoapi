import { BadRequestException, Injectable } from '@nestjs/common';
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
          return await this.prisma.shipment.findMany({ where: { customerId: userId }, orderBy: { createdAt: 'desc' } });
        case 'owner-trucks':
          return await this.prisma.vehicle.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'desc' } });
        case 'driver-jobs':
        case 'active-trips':
          return await this.prisma.driverAssignment.findMany({
            where: { driverId: userId },
            include: { shipment: true, vehicle: true },
            orderBy: { offeredAt: 'desc' },
          });
        case 'chat-threads':
          return await this.prisma.conversation.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 });
        case 'wallet-transactions':
        case 'shipment-offers':
        case 'verification':
        case 'seeking-drivers':
        case 'dispatcher-shipments':
        case 'dispatcher-disputes':
        case 'platform-users':
        case 'operation-drivers':
        case 'operation-shipments':
          return [];
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
