import type { ConfigService } from '@nestjs/config';
import type { RateLimitService } from '../auth/rate-limit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MapsProviderService } from './maps-provider.service';

// Prints sample quotes with the default settings (run: npx jest pricing-examples). Asserts only
// that every quote is the carrier cost plus commission.
describe('pricing examples (default settings)', () => {
  const originalFetch = global.fetch;
  afterAll(() => { global.fetch = originalFetch; });

  const trips = [
    { name: 'Pickup, Lagos local, 25 km, 0.5 t', km: 25, truckType: 'Pickup', weightTons: 0.5 },
    { name: 'Cargo van, Ikeja to Lekki, 40 km, 1.5 t', km: 40, truckType: 'Cargo van', weightTons: 1.5 },
    { name: 'Light truck, Lagos to Abeokuta, 80 km, 4 t', km: 80, truckType: 'Light truck', weightTons: 4 },
    { name: 'Flatbed, Ikeja to Ibadan, 120.4 km, 5 t', km: 120.4, truckType: 'Flatbed', weightTons: 5 },
    { name: 'Flatbed, Ikeja to Ibadan, 120.4 km, 30 t', km: 120.4, truckType: 'Flatbed', weightTons: 30 },
    { name: 'Standard truck, Lagos to Abuja, 760 km, 18 t', km: 760, truckType: 'Standard truck', weightTons: 18 },
  ];

  it.each(trips)('$name', async ({ name, km, truckType, weightTons }) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ routes: [{ distanceMeters: km * 1000, duration: `${Math.round((km / 50) * 3600)}s` }] }),
    }) as unknown as typeof fetch;
    const service = new MapsProviderService(
      { get: (key: string) => (key === 'GOOGLE_MAPS_API_KEY' ? 'k' : undefined) } as unknown as ConfigService,
      { platformSetting: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService,
      { assertAllowed: jest.fn() } as unknown as RateLimitService,
    );
    const q = await service.routeEstimate({ originLatitude: 6.6, originLongitude: 3.35, destinationLatitude: 7.4, destinationLongitude: 3.9, truckType, weightTons });
    const b = q.pricingBreakdown;
    const n = (kobo: unknown) => `NGN ${Math.round(Number(kobo) / 100).toLocaleString('en-US')}`;
    process.stdout.write(`EXAMPLE | ${name} | customer ${n(q.quotedPriceKobo)} | carrier ${n(b.carrierCostKobo)} (fuel ${n(b.fuelCostKobo)} for ${b.fuelLitres} L ${b.fuelType}, running ${n(b.operatingCostKobo)}, base ${n(b.baseFareKobo)}${Number(b.minimumFareAdjustmentKobo) ? `, minimum-fare top-up ${n(b.minimumFareAdjustmentKobo)}` : ''}) | Trako ${n(b.commissionKobo)}\n`);
    expect(Number(b.carrierCostKobo) + Number(b.commissionKobo)).toBe(q.quotedPriceKobo);
  });
});
