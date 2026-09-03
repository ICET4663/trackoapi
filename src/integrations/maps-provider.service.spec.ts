import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { MapsProviderService } from './maps-provider.service';

describe('MapsProviderService route pricing', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(options: { googleKey?: string; settings?: Array<{ key: string; value: string }> } = {}) {
    const config = {
      get: jest.fn((key: string) => key === 'GOOGLE_MAPS_API_KEY' ? options.googleKey : undefined),
    } as unknown as ConfigService;
    const prisma = {
      platformSetting: {
        findMany: jest.fn().mockResolvedValue(options.settings ?? []),
      },
    } as unknown as PrismaService;
    return new MapsProviderService(config, prisma);
  }

  const routeInput = {
    originLatitude: 6.5244,
    originLongitude: 3.3792,
    destinationLatitude: 9.0765,
    destinationLongitude: 7.3986,
    truckType: 'Flatbed',
    weightTons: 15,
  };

  it('returns a usable coordinate quote when live routing is not configured', async () => {
    const quote = await createService().routeEstimate(routeInput);

    expect(quote.provider).toBe('coordinate');
    expect(quote.pricingMode).toBe('coordinate_estimate');
    expect(quote.quotedPriceKobo).toBeGreaterThan(0);
    expect(quote.pricingBreakdown.routeSource).toBe('coordinate_factor');
    expect(quote.quoteValidMinutes).toBe(30);
  });

  it('applies persisted fuel, toll, surge, fee, and validity controls', async () => {
    const quote = await createService({
      settings: [
        { key: 'pricingServiceFeePercent', value: '10' },
        { key: 'pricingFuelSurchargePercent', value: '12.5' },
        { key: 'pricingTollAllowanceNgn', value: '5000' },
        { key: 'pricingDemandSurgePercent', value: '20' },
        { key: 'pricingQuoteValidityMinutes', value: '60' },
      ],
    }).routeEstimate(routeInput);

    expect(quote.quoteValidMinutes).toBe(60);
    expect(quote.pricingBreakdown.fuelSurchargeKobo).toBeGreaterThan(0);
    expect(quote.pricingBreakdown.tollAllowanceKobo).toBe(500_000);
    expect(quote.pricingBreakdown.demandSurgeKobo).toBeGreaterThan(0);
    expect(quote.pricingBreakdown.serviceFeeRate).toBe(0.1);
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
        { key: 'pricingFlatbedPerKmRateNgn', value: '1200' },
        { key: 'pricingFlatbedMinimumFareNgn', value: '150000' },
      ],
    }).routeEstimate(routeInput);

    expect(quote.pricingBreakdown.baseFareKobo).toBe(8_000_000);
    expect(quote.pricingBreakdown.perKmRateKobo).toBe(120_000);
    expect(quote.quotedPriceKobo).toBeGreaterThanOrEqual(15_000_000);
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
});
