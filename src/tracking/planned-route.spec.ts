import { ForbiddenException } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import type { MapsProviderService } from '../integrations/maps-provider.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';

// The customer's map showed only the route driven so far; the planned road route from
// pickup to destination is now fetched from Google once per shipment and stored.
describe('TrackingService.plannedRoute', () => {
  const lagos = { pickupLatitude: 6.6018, pickupLongitude: 3.3515, destinationLatitude: 7.3775, destinationLongitude: 3.947 };

  function buildService(row: Record<string, unknown> | undefined, roadRoute = jest.fn().mockResolvedValue({ encodedPolyline: '_p~iF~ps|U_ulLnnqC', distanceKm: 120.4, durationMinutes: 115 })) {
    const executeRawUnsafe = jest.fn().mockResolvedValue(1);
    const prisma = {
      shipment: { findFirst: jest.fn().mockResolvedValue({ id: 'shp-1', customerId: 'cust-1' }) },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRawUnsafe: jest.fn().mockResolvedValue(row ? [row] : []),
      $executeRawUnsafe: executeRawUnsafe,
    } as unknown as PrismaService;
    const maps = { roadRoute } as unknown as MapsProviderService;
    const service = new TrackingService(prisma, {} as NotificationsService, maps);
    return { service, roadRoute, executeRawUnsafe };
  }

  const customer = { sub: 'cust-1', role: 'CUSTOMER' as const, email: 'c@x', verificationStatus: 'VERIFIED' };

  it('returns the stored route without calling Google again', async () => {
    const { service, roadRoute } = buildService({ ...lagos, plannedRoutePolyline: 'stored-line' });

    await expect(service.plannedRoute('shp-1', customer as never)).resolves.toEqual({ encodedPolyline: 'stored-line' });
    expect(roadRoute).not.toHaveBeenCalled();
  });

  it('fetches the road route once and stores it for next time', async () => {
    const { service, roadRoute, executeRawUnsafe } = buildService({ ...lagos, plannedRoutePolyline: null });

    await expect(service.plannedRoute('shp-1', customer as never)).resolves.toEqual({ encodedPolyline: '_p~iF~ps|U_ulLnnqC' });
    expect(roadRoute).toHaveBeenCalledWith({ latitude: 6.6018, longitude: 3.3515 }, { latitude: 7.3775, longitude: 3.947 });
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('set "plannedRoutePolyline" = $2 where "id" = $1 and "plannedRoutePolyline" is null'),
      'shp-1',
      '_p~iF~ps|U_ulLnnqC',
    );
  });

  it('returns no route, without calling Google, when the shipment has no map coordinates', async () => {
    const { service, roadRoute } = buildService({ ...lagos, destinationLatitude: null, plannedRoutePolyline: null });

    await expect(service.plannedRoute('shp-1', customer as never)).resolves.toEqual({ encodedPolyline: null });
    expect(roadRoute).not.toHaveBeenCalled();
  });

  it('returns no route when Google has none (or Maps is not configured), and stores nothing', async () => {
    const { service, executeRawUnsafe } = buildService({ ...lagos, plannedRoutePolyline: null }, jest.fn().mockResolvedValue(null));

    await expect(service.plannedRoute('shp-1', customer as never)).resolves.toEqual({ encodedPolyline: null });
    expect(executeRawUnsafe).not.toHaveBeenCalledWith(expect.stringContaining('update "Shipment"'), expect.anything(), expect.anything());
  });

  it('another customer cannot read this shipment\'s route', async () => {
    const { service, roadRoute } = buildService({ ...lagos, plannedRoutePolyline: 'stored-line' });

    await expect(service.plannedRoute('shp-1', { ...customer, sub: 'cust-other' } as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(roadRoute).not.toHaveBeenCalled();
  });
});
