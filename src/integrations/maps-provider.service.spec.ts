import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { RateLimitService } from '../auth/rate-limit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MapsProviderService } from './maps-provider.service';

describe('MapsProviderService route pricing', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(options: { googleKey?: string; settings?: Array<{ key: string; value: string }>; rateLimit?: RateLimitService } = {}) {
    const config = {
      get: jest.fn((key: string) => key === 'GOOGLE_MAPS_API_KEY' ? options.googleKey : undefined),
    } as unknown as ConfigService;
    const prisma = {
      platformSetting: {
        findMany: jest.fn().mockResolvedValue(options.settings ?? []),
      },
    } as unknown as PrismaService;
    const rateLimit = options.rateLimit ?? ({ assertAllowed: jest.fn().mockResolvedValue(undefined) } as unknown as RateLimitService);
    return new MapsProviderService(config, prisma, rateLimit);
  }

  const routeInput = {
    originLatitude: 6.5244,
    originLongitude: 3.3792,
    destinationLatitude: 9.0765,
    destinationLongitude: 7.3986,
    truckType: 'Flatbed',
    weightTons: 15,
  };

  it('roadRoute() asks Google for the route geometry and returns it', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ routes: [{ distanceMeters: 120400, duration: '6900s', polyline: { encodedPolyline: '_p~iF~ps|U' } }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const service = createService({ googleKey: 'test-key' });

    const route = await service.roadRoute({ latitude: 6.6, longitude: 3.35 }, { latitude: 7.38, longitude: 3.95 });

    expect(route).toEqual({ encodedPolyline: '_p~iF~ps|U', distanceKm: 120.4, durationMinutes: 115 });
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['X-Goog-FieldMask']).toContain('routes.polyline.encodedPolyline');
  });

  it('roadRoute() returns null without a Maps key, and without calling Google', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(createService().roadRoute({ latitude: 6.6, longitude: 3.35 }, { latitude: 7.38, longitude: 3.95 })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0.01, 800])('itemises the minimum fare without changing the quote for distance %s', async distance => {
    const service = createService();
    const quote = await service.routeEstimate({ ...routeInput, destinationLatitude: routeInput.originLatitude + distance / 111, destinationLongitude: routeInput.originLongitude });
    const b = quote.pricingBreakdown;
    const sum = ['baseFareKobo', 'linehaulKobo', 'escrowFeeKobo', 'fuelSurchargeKobo', 'tollAllowanceKobo', 'demandSurgeKobo', 'minimumFareAdjustmentKobo']
      .reduce((total, key) => total + Number(b[key] ?? 0), 0);
    expect(sum).toBe(quote.quotedPriceKobo);
    expect(Number(b.minimumFareAdjustmentKobo)).toBeGreaterThanOrEqual(0);
    if (distance < 1) expect(Number(b.minimumFareAdjustmentKobo)).toBeGreaterThan(0);
    else expect(b.minimumFareAdjustmentKobo).toBe(0);
  });

  it('returns a usable coordinate quote when live routing is not configured', async () => {
    const quote = await createService().routeEstimate(routeInput);

    expect(quote.provider).toBe('coordinate');
    expect(quote.pricingMode).toBe('coordinate_estimate');
    expect(quote.quotedPriceKobo).toBeGreaterThan(0);
    expect(quote.pricingBreakdown.routeSource).toBe('coordinate_factor');
    expect(quote.quoteValidMinutes).toBe(30);
  });

  it('applies persisted toll, surge, commission and validity controls', async () => {
    const quote = await createService({
      settings: [
        { key: 'fee', value: '10' },
        { key: 'pricingTollAllowanceNgn', value: '5000' },
        { key: 'pricingDemandSurgePercent', value: '20' },
        { key: 'pricingQuoteValidityMinutes', value: '60' },
      ],
    }).routeEstimate(routeInput);

    expect(quote.quoteValidMinutes).toBe(60);
    expect(quote.pricingBreakdown.tollAllowanceKobo).toBe(500_000);
    expect(quote.pricingBreakdown.demandSurgeKobo).toBeGreaterThan(0);
    expect(quote.pricingBreakdown.commissionRate).toBe(0.1);
    expect(quote.pricingBreakdown.commissionKobo).toBe(Math.round(Number(quote.pricingBreakdown.carrierCostKobo) / 100 * 0.1) * 100);
  });

  // The end-to-end trip of 6 Nov: Ikeja City Mall to Bodija Market, 120.4 km by Google,
  // 5 t on a flatbed, default settings. Worked by hand:
  //   litres: 120.4 x (30 + 8 x 5/30) / 100 + 120.4 x 0.7 x 30 / 100 = 63.009 L
  //   fuel 63.009 x NGN 1,700 = 107,116; running 120.4 x 380 = 45,752; base 50,000
  //   carrier 202,868; commission 7.5% = 15,215; customer pays 218,083
  it('prices a trip from fuel at the pump price, running costs and base fare, plus commission', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ routes: [{ distanceMeters: 120_400, duration: '7860s' }] }),
    }) as unknown as typeof fetch;

    const quote = await createService({ googleKey: 'test-key' }).routeEstimate({ ...routeInput, weightTons: 5 });
    const b = quote.pricingBreakdown;

    expect(b.fuelType).toBe('DIESEL');
    expect(b.fuelPricePerLitreNgn).toBe(1_700);
    expect(b.fuelLitres).toBe(63);
    expect(b.fuelCostKobo).toBe(10_711_600);
    expect(b.operatingCostKobo).toBe(4_575_200);
    expect(b.baseFareKobo).toBe(5_000_000);
    expect(b.carrierCostKobo).toBe(20_286_800);
    expect(b.commissionKobo).toBe(1_521_500);
    expect(quote.quotedPriceKobo).toBe(21_808_300);
    expect(Number(b.carrierCostKobo) + Number(b.commissionKobo)).toBe(quote.quotedPriceKobo);
    expect(quote.pricingVersion).toBe('2026-11-fuel-indexed-1');
  });

  it('follows the petrol price for pickups and the diesel price for trucks', async () => {
    const pickup = { ...routeInput, truckType: 'Pickup', weightTons: 0.5 };
    const base = createService();
    const dearPetrol = createService({ settings: [{ key: 'pricingPetrolPriceNgn', value: '2000' }] });
    const dearDiesel = createService({ settings: [{ key: 'pricingDieselPriceNgn', value: '2500' }] });

    const [pickupBase, pickupPetrol, pickupDiesel] = await Promise.all([base, dearPetrol, dearDiesel].map((s) => s.routeEstimate(pickup)));
    const [truckBase, truckPetrol, truckDiesel] = await Promise.all([base, dearPetrol, dearDiesel].map((s) => s.routeEstimate(routeInput)));

    expect(pickupBase.pricingBreakdown.fuelType).toBe('PETROL');
    expect(pickupPetrol.quotedPriceKobo).toBeGreaterThan(pickupBase.quotedPriceKobo);
    expect(pickupDiesel.quotedPriceKobo).toBe(pickupBase.quotedPriceKobo);
    expect(truckDiesel.quotedPriceKobo).toBeGreaterThan(truckBase.quotedPriceKobo);
    expect(truckPetrol.quotedPriceKobo).toBe(truckBase.quotedPriceKobo);
  });

  it('charges the empty drive back only as far as the empty-return setting says', async () => {
    const always = await createService({ settings: [{ key: 'pricingEmptyReturnPercent', value: '100' }] }).routeEstimate(routeInput);
    const never = await createService({ settings: [{ key: 'pricingEmptyReturnPercent', value: '0' }] }).routeEstimate(routeInput);

    expect(Number(always.pricingBreakdown.fuelLitres)).toBeGreaterThan(Number(never.pricingBreakdown.fuelLitres));
    expect(always.quotedPriceKobo).toBeGreaterThan(never.quotedPriceKobo);
  });

  it('adds the commission on top of the minimum fare, so the carrier always gets the minimum', async () => {
    const quote = await createService({ settings: [{ key: 'fee', value: '10' }] })
      .routeEstimate({ ...routeInput, destinationLatitude: routeInput.originLatitude + 0.001, destinationLongitude: routeInput.originLongitude });

    expect(quote.pricingBreakdown.carrierCostKobo).toBe(10_000_000);
    expect(quote.pricingBreakdown.commissionKobo).toBe(1_000_000);
    expect(quote.quotedPriceKobo).toBe(11_000_000);
  });

  it('uses live Google road distance and duration when Routes API succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ routes: [{ distanceMeters: 123_400, duration: '7200s' }] }),
    }) as unknown as typeof fetch;

    const quote = await createService({ googleKey: 'test-key' }).routeEstimate(routeInput);

    expect(quote.provider).toBe('google');
    expect(quote.pricingMode).toBe('live_road_route');
    expect(quote.distanceKm).toBe(123.4);
    expect(quote.durationMinutes).toBe(120);
    expect(quote.pricingBreakdown.routeSource).toBe('google_routes');
  });

  it('reverse geocodes GPS coordinates through Google', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        results: [{
          place_id: 'place-lagos',
          formatted_address: '12 Marina Road, Lagos, Nigeria',
          geometry: { location: { lat: 6.44686, lng: 3.39736 } },
        }],
      }),
    }) as unknown as typeof fetch;

    const result = await createService({ googleKey: 'test-key' }).geocode('6.44686,3.39736');

    expect(result.provider).toBe('google');
    expect(result.result.address).toBe('12 Marina Road, Lagos, Nigeria');
    expect(global.fetch).toHaveBeenCalledWith(expect.objectContaining({
      searchParams: expect.any(URLSearchParams),
    }));
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('latlng=6.44686%2C3.39736');
  });

  it('preserves GPS coordinates when reverse geocoding is unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Google unavailable')) as unknown as typeof fetch;

    const result = await createService({ googleKey: 'test-key' }).geocode('6.44686,3.39736');

    expect(result.provider).toBe('coordinate');
    expect(result.result.latitude).toBe(6.44686);
    expect(result.result.longitude).toBe(3.39736);
    expect(result.result.address).toContain('6.44686, 3.39736');
  });

  it('uses the persisted rate card for the selected truck type', async () => {
    const quote = await createService({
      settings: [
        { key: 'pricingFlatbedBaseFareNgn', value: '80000' },
        { key: 'pricingFlatbedOperatingPerKmNgn', value: '600' },
        { key: 'pricingFlatbedMinimumFareNgn', value: '150000' },
      ],
    }).routeEstimate(routeInput);

    expect(quote.pricingBreakdown.baseFareKobo).toBe(8_000_000);
    expect(quote.pricingBreakdown.operatingPerKmKobo).toBe(60_000);
    expect(Number(quote.pricingBreakdown.carrierCostKobo)).toBeGreaterThanOrEqual(15_000_000);
  });

  it('verifies the exact signed quote that the customer previewed', async () => {
    const service = createService();
    const quote = await service.routeEstimate(routeInput);

    const accepted = service.verifyQuoteToken(quote.quoteToken, routeInput);

    expect(accepted.quotedPriceKobo).toBe(quote.quotedPriceKobo);
    expect(accepted.pricingVersion).toBe(quote.pricingVersion);
    expect(accepted.quoteExpiresAt).toBe(quote.quoteExpiresAt);
  });

  it('rejects a signed quote after shipment details change', async () => {
    const service = createService();
    const quote = await service.routeEstimate(routeInput);

    expect(() => service.verifyQuoteToken(quote.quoteToken, { ...routeInput, weightTons: 16 })).toThrow(
      'Shipment details changed',
    );
  });

  it('rejects a quote token whose signature was altered', async () => {
    const service = createService();
    const quote = await service.routeEstimate(routeInput);
    const [payload, signature] = quote.quoteToken.split('.');
    // Flipping the FIRST character, not the last: a base64url-encoded 32-byte HMAC-SHA256
    // digest is 43 characters, and the final character always carries 2 "don't care"
    // padding bits (256 bits doesn't divide evenly by 6 bits/char) - flipping between two
    // specific characters there (this used to flip only between 'a' and 'b', which differ
    // solely in that padding-bit position) can decode to byte-IDENTICAL signatures despite
    // being a different string, making the tamper a no-op and this test flaky. The first
    // character is always fully bit-significant, so changing it always changes real bytes.
    const tamperedFirstChar = signature[0] === 'a' ? 'b' : 'a';
    const tampered = `${payload}.${tamperedFirstChar}${signature.slice(1)}`;

    expect(() => service.verifyQuoteToken(tampered, routeInput)).toThrow('quote is invalid');
  });

  it('rejects cargo that exceeds the selected truck capacity', async () => {
    await expect(createService().routeEstimate({ ...routeInput, weightTons: 31 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('burns more fuel, and costs more, the heavier the load', async () => {
    const service = createService();
    const light = await service.routeEstimate({ ...routeInput, weightTons: 3 });
    const full = await service.routeEstimate({ ...routeInput, weightTons: 30 });

    expect(light.pricingBreakdown.loadUtilization).toBe(0.1);
    expect(full.pricingBreakdown.loadUtilization).toBe(1);
    expect(Number(full.pricingBreakdown.fuelLitres)).toBeGreaterThan(Number(light.pricingBreakdown.fuelLitres));
    expect(full.pricingBreakdown.operatingCostKobo).toBe(light.pricingBreakdown.operatingCostKobo);
    expect(full.quotedPriceKobo).toBeGreaterThan(light.quotedPriceKobo);
  });

  it('prices bulky cargo using space utilization when it is higher than weight utilization', async () => {
    const service = createService();
    const compact = await service.routeEstimate({ ...routeInput, weightTons: 3, volumeM3: 5 });
    const bulky = await service.routeEstimate({ ...routeInput, weightTons: 3, volumeM3: 44 });

    expect(bulky.pricingBreakdown.limitingFactor).toBe('space');
    expect(bulky.pricingBreakdown.volumeUtilization).toBe(0.8);
    expect(bulky.pricingBreakdown.loadUtilization).toBe(0.8);
    expect(bulky.quotedPriceKobo).toBeGreaterThan(compact.quotedPriceKobo);
  });

  it('allows a space-only quote without inventing cargo weight', async () => {
    const quote = await createService().routeEstimate({ ...routeInput, weightTons: undefined, volumeM3: 22 });

    expect(quote.pricingBreakdown.weightTons).toBe(0);
    expect(quote.pricingBreakdown.volumeUtilization).toBe(0.4);
    expect(quote.pricingBreakdown.limitingFactor).toBe('space');
  });

  it('rejects cargo volume that exceeds the selected truck space', async () => {
    await expect(createService().routeEstimate({ ...routeInput, weightTons: 3, volumeM3: 56 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// These proxy paid Google Maps calls behind session auth only - with no per-caller
// ceiling, a single compromised or scripted account could run up unbounded real
// Google Cloud billing. Confirms each entry point is actually rate-limited per actor,
// keyed distinctly per endpoint, and that a limit hit is a real rejection rather than
// silently falling through to the mock/coordinate fallback.
describe('MapsProviderService paid-endpoint rate limiting', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const routeInput = {
    originLatitude: 6.5244,
    originLongitude: 3.3792,
    destinationLatitude: 9.0765,
    destinationLongitude: 7.3986,
    truckType: 'Flatbed',
    weightTons: 15,
  };

  function createService(rateLimit: RateLimitService) {
    const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const prisma = { platformSetting: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    return new MapsProviderService(config, prisma, rateLimit);
  }

  it('rate-limits places() per actor, distinctly from the other endpoints', async () => {
    const assertAllowed = jest.fn().mockResolvedValue(undefined);
    const service = createService({ assertAllowed } as unknown as RateLimitService);

    await service.places('lekki', 'driver-1');

    expect(assertAllowed).toHaveBeenCalledWith('maps-places:driver-1', expect.objectContaining({ limit: 60, label: 'Location search' }));
  });

  it('rate-limits geocode() per actor', async () => {
    const assertAllowed = jest.fn().mockResolvedValue(undefined);
    const service = createService({ assertAllowed } as unknown as RateLimitService);

    await service.geocode('Lekki Phase 1', 'driver-1');

    expect(assertAllowed).toHaveBeenCalledWith('maps-geocode:driver-1', expect.objectContaining({ limit: 30, label: 'Address lookup' }));
  });

  it('rate-limits routeEstimate() per actor', async () => {
    const assertAllowed = jest.fn().mockResolvedValue(undefined);
    const service = createService({ assertAllowed } as unknown as RateLimitService);

    await service.routeEstimate(routeInput, 'driver-1');

    expect(assertAllowed).toHaveBeenCalledWith('maps-route-estimate:driver-1', expect.objectContaining({ limit: 20, label: 'Route pricing' }));
  });

  it('propagates a real rejection when the limit is hit, rather than falling through to a fallback result', async () => {
    const assertAllowed = jest.fn().mockRejectedValue(new Error('Location search rate limit reached. Try again later.'));
    const service = createService({ assertAllowed } as unknown as RateLimitService);

    await expect(service.places('lekki', 'driver-1')).rejects.toThrow('rate limit reached');
  });
});
