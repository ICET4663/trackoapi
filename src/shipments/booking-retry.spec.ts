import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';

// A booking whose response was lost on a bad connection used to create a second shipment
// when the customer tapped "try again", and a booking with no addresses at all was saved
// as "Pickup" to "Destination". Found by the live acceptance run (B3, B4), 14 October.
describe('ShipmentsService.create booking safety', () => {
  const booking = { origin: 'Ikeja City Mall, Lagos', destination: 'Bodija Market, Ibadan', clientRequestId: 'attempt-1' };

  function buildService({ claimed = true, existingShipmentId = null as string | null, insertFails = false } = {}) {
    const queryRawUnsafe = jest.fn((sql: string) => {
      if (sql.includes('from "User"')) return Promise.resolve([{ verificationStatus: 'VERIFIED', role: 'CUSTOMER', isActive: true }]);
      if (sql.includes('insert into "ShipmentBookingKey"')) return Promise.resolve(claimed ? [{ customerId: 'cust-1' }] : []);
      if (sql.includes('select "shipmentId" from "ShipmentBookingKey"')) return Promise.resolve([{ shipmentId: existingShipmentId }]);
      return Promise.resolve([]);
    });
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const shipmentCreate = insertFails
      ? jest.fn().mockRejectedValue(new Error('connection reset'))
      : jest.fn().mockResolvedValue({ id: 'shp-new', reference: 'TRK-1', customerId: 'cust-1', status: 'DRAFT', timeline: [] });
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
      platformSetting: { findUnique: jest.fn().mockResolvedValue(null) },
      shipment: { create: shipmentCreate },
    } as unknown as PrismaService;
    const notifications = { create: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService;
    const mapsProvider = {
      routeEstimate: jest.fn().mockResolvedValue({ quotedPriceKobo: 10_000_000, distanceKm: 122, durationMinutes: 120, pricingVersion: 'v1', quoteValidMinutes: 30, pricingBreakdown: {} }),
    } as unknown as MapsProviderService;
    const service = new ShipmentsService(prisma, notifications, mapsProvider);
    const internals = service as unknown as Record<string, jest.Mock>;
    jest.spyOn(internals, 'recordQuoteSnapshot' as never).mockResolvedValue(undefined as never);
    jest.spyOn(internals, 'createEscrowRecord' as never).mockResolvedValue({ id: 'esc-1' } as never);
    const get = jest.spyOn(service, 'get').mockResolvedValue({ id: 'shp-existing' } as never);
    return { service, shipmentCreate, executeRawUnsafe, get };
  }

  it('refuses a booking without a pickup or destination address', async () => {
    const { service, shipmentCreate } = buildService();

    await expect(service.create('cust-1', { cargoType: 'Rice' } as never)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('cust-1', { origin: 'Lagos', destination: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(shipmentCreate).not.toHaveBeenCalled();
  });

  it('books once and links the retry key to the new shipment', async () => {
    const { service, shipmentCreate, executeRawUnsafe } = buildService();

    await expect(service.create('cust-1', booking)).resolves.toMatchObject({ id: 'shp-new' });
    expect(shipmentCreate).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('set "shipmentId" = $3'), 'cust-1', 'attempt-1', 'shp-new');
  });

  it('a retry with the same key returns the shipment already booked, without booking again', async () => {
    const { service, shipmentCreate, get } = buildService({ claimed: false, existingShipmentId: 'shp-existing' });

    await expect(service.create('cust-1', booking)).resolves.toEqual({ id: 'shp-existing' });
    expect(get).toHaveBeenCalledWith('shp-existing', 'cust-1', 'CUSTOMER');
    expect(shipmentCreate).not.toHaveBeenCalled();
  });

  it('a retry while the first attempt is still saving is told to wait, not booked twice', async () => {
    const { service, shipmentCreate } = buildService({ claimed: false, existingShipmentId: null });

    await expect(service.create('cust-1', booking)).rejects.toBeInstanceOf(ConflictException);
    expect(shipmentCreate).not.toHaveBeenCalled();
  });

  it('a failed save frees the key so the customer can retry', async () => {
    const { service, executeRawUnsafe } = buildService({ insertFails: true });

    await expect(service.create('cust-1', booking)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('delete from "ShipmentBookingKey"'), 'cust-1', 'attempt-1');
  });

  it('bookings from older app versions (no key) still work', async () => {
    const { service, shipmentCreate, executeRawUnsafe } = buildService();

    await expect(service.create('cust-1', { origin: 'Lagos', destination: 'Ibadan' })).resolves.toMatchObject({ id: 'shp-new' });
    expect(shipmentCreate).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining('ShipmentBookingKey'), expect.anything(), expect.anything(), expect.anything());
  });
});
