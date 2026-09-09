import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type PlaceSuggestion = {
  id: string;
  label: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  provider: string;
};

const PREVIEW_PLACES: PlaceSuggestion[] = [
  {
    id: 'preview-lagos-lekki',
    label: 'Lekki Phase 1',
    address: 'Lekki Phase 1, Lagos, Nigeria',
    city: 'Lagos',
    state: 'Lagos',
    latitude: 6.4474,
    longitude: 3.4723,
    provider: 'mock',
  },
  {
    id: 'preview-lagos-vi',
    label: 'Victoria Island',
    address: 'Victoria Island, Lagos, Nigeria',
    city: 'Lagos',
    state: 'Lagos',
    latitude: 6.4281,
    longitude: 3.4219,
    provider: 'mock',
  },
  {
    id: 'preview-abuja-wuse',
    label: 'Wuse Market',
    address: 'Wuse Market, Abuja, Nigeria',
    city: 'Abuja',
    state: 'FCT',
    latitude: 9.0765,
    longitude: 7.3986,
    provider: 'mock',
  },
  {
    id: 'preview-ibadan-dugbe',
    label: 'Dugbe',
    address: 'Dugbe, Ibadan, Oyo, Nigeria',
    city: 'Ibadan',
    state: 'Oyo',
    latitude: 7.3878,
    longitude: 3.8792,
    provider: 'mock',
  },
  {
    id: 'preview-kano-sabongari',
    label: 'Sabon Gari Market',
    address: 'Sabon Gari Market, Kano, Nigeria',
    city: 'Kano',
    state: 'Kano',
    latitude: 12.0022,
    longitude: 8.5919,
    provider: 'mock',
  },
  {
    id: 'preview-ph-transamadi',
    label: 'Trans-Amadi Industrial Layout',
    address: 'Trans-Amadi Industrial Layout, Port Harcourt, Nigeria',
    city: 'Port Harcourt',
    state: 'Rivers',
    latitude: 4.8156,
    longitude: 7.0498,
    provider: 'mock',
  },
];

const ROAD_FACTOR = 1.29;
const AVERAGE_SPEED_KMH = 58;
const PRICING_VERSION = '2026-09-vehicle-catalogue-1';

// Admin-overridable defaults for the five rate-carded vehicle classes. The wider
// catalogue below carries its own fixed rates (not admin-tuned yet).
const PRICING_SETTING_DEFAULTS = {
  pricingServiceFeePercent: 3.5,
  pricingFuelSurchargePercent: 0,
  pricingTollAllowanceNgn: 0,
  pricingDemandSurgePercent: 0,
  pricingQuoteValidityMinutes: 30,
  pricingFlatbedBaseFareNgn: 60_000,
  pricingFlatbedPerKmRateNgn: 780,
  pricingFlatbedMinimumFareNgn: 115_000,
  pricingBoxBaseFareNgn: 45_000,
  pricingBoxPerKmRateNgn: 620,
  pricingBoxMinimumFareNgn: 85_000,
  pricingTipperBaseFareNgn: 65_000,
  pricingTipperPerKmRateNgn: 800,
  pricingTipperMinimumFareNgn: 120_000,
  pricingTankerBaseFareNgn: 75_000,
  pricingTankerPerKmRateNgn: 860,
  pricingTankerMinimumFareNgn: 135_000,
  pricingStandardBaseFareNgn: 45_000,
  pricingStandardPerKmRateNgn: 620,
  pricingStandardMinimumFareNgn: 85_000,
} as const;

type TruckPricingProfile = {
  label: string;
  capacityTons: number;
  capacityM3: number;
  baseFareNgn: number;
  perKmRateNgn: number;
  minimumFareNgn: number;
};

type RouteEstimateInput = {
  originLatitude?: number;
  originLongitude?: number;
  destinationLatitude?: number;
  destinationLongitude?: number;
  truckType?: string;
  weightTons?: number;
  volumeM3?: number;
};

type NormalizedQuoteInput = {
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  truckType: string;
  weightTons: number;
  volumeM3: number;
};

type RouteQuoteCore = {
  provider: string;
  distanceKm: number;
  durationMinutes: number;
  quotedPriceKobo: number;
  currency: string;
  pricingMode: string;
  pricingVersion: string;
  quoteValidMinutes: number;
  pricingBreakdown: Record<string, string | number>;
};

type RouteQuote = RouteQuoteCore & {
  quoteToken: string;
  quoteExpiresAt: string;
};

type SignedQuotePayload = {
  input: NormalizedQuoteInput;
  quote: RouteQuoteCore;
  expiresAt: string;
};

// Keyed by a lowercase substring of the truck-type name. Matched in declaration
// order (see truckProfile), so the specific keys come before the generic ones
// ("light"/"refrigerat" before "truck"; "container"/"lowbed"/"articulated" before
// "trailer"). Capacities MUST match the frontend src/constants/truck-catalog.ts,
// or a truck that passes the client capacity check gets rejected here. Per-km
// rates scale with vehicle size plus a fixed dispatch base fare - typical
// Nigerian road-freight economics.
const TRUCK_PRICING: Record<string, TruckPricingProfile> = {
  pickup: { label: 'Pickup', capacityTons: 1, capacityM3: 4, baseFareNgn: 12_000, perKmRateNgn: 180, minimumFareNgn: 20_000 },
  van: { label: 'Cargo van', capacityTons: 2, capacityM3: 9, baseFareNgn: 16_000, perKmRateNgn: 240, minimumFareNgn: 28_000 },
  light: { label: 'Light truck', capacityTons: 6, capacityM3: 20, baseFareNgn: 26_000, perKmRateNgn: 400, minimumFareNgn: 48_000 },
  refrigerat: { label: 'Refrigerated truck', capacityTons: 12, capacityM3: 38, baseFareNgn: 60_000, perKmRateNgn: 780, minimumFareNgn: 115_000 },
  box: { label: 'Box truck', capacityTons: 15, capacityM3: 45, baseFareNgn: 45_000, perKmRateNgn: 620, minimumFareNgn: 85_000 },
  flatbed: { label: 'Flatbed', capacityTons: 30, capacityM3: 55, baseFareNgn: 60_000, perKmRateNgn: 780, minimumFareNgn: 115_000 },
  tipper: { label: 'Tipper', capacityTons: 30, capacityM3: 18, baseFareNgn: 65_000, perKmRateNgn: 800, minimumFareNgn: 120_000 },
  tanker: { label: 'Tanker', capacityTons: 33, capacityM3: 38, baseFareNgn: 75_000, perKmRateNgn: 860, minimumFareNgn: 135_000 },
  container: { label: 'Container trailer', capacityTons: 30, capacityM3: 67, baseFareNgn: 80_000, perKmRateNgn: 900, minimumFareNgn: 150_000 },
  lowbed: { label: 'Lowbed trailer', capacityTons: 45, capacityM3: 30, baseFareNgn: 120_000, perKmRateNgn: 1_150, minimumFareNgn: 250_000 },
  articulated: { label: 'Articulated trailer', capacityTons: 40, capacityM3: 90, baseFareNgn: 90_000, perKmRateNgn: 950, minimumFareNgn: 175_000 },
  trailer: { label: 'Trailer', capacityTons: 35, capacityM3: 70, baseFareNgn: 80_000, perKmRateNgn: 900, minimumFareNgn: 150_000 },
  truck: { label: 'Standard truck', capacityTons: 20, capacityM3: 40, baseFareNgn: 45_000, perKmRateNgn: 620, minimumFareNgn: 85_000 },
};

const ADMIN_TUNED_KEYS = new Set(['flatbed', 'box', 'tipper', 'tanker', 'truck']);

@Injectable()
export class MapsProviderService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  status() {
    const configured = Boolean(this.config.get<string>('GOOGLE_MAPS_API_KEY'));
    return {
      provider: configured ? 'google' : 'mock',
      mode: configured ? 'configured' : 'mock',
      realRoutingEnabled: configured,
      requiredEnv: ['GOOGLE_MAPS_API_KEY'],
      endpoints: [
        'GET /v1/maps/places?query=...',
        'GET /v1/maps/geocode?address=...',
        'POST /v1/maps/route-estimate',
      ],
    };
  }

  async places(query = '') {
    const key = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    if (key && query.trim().length >= 2) {
      const google = await this.googlePlaces(query, key).catch(() => null);
      if (google?.length) return { provider: 'google', results: google };
    }

    const normalized = query.trim().toLowerCase();
    const results = normalized
      ? PREVIEW_PLACES.filter((place) =>
          `${place.label} ${place.address} ${place.city} ${place.state}`.toLowerCase().includes(normalized),
        )
      : PREVIEW_PLACES;

    return { provider: 'mock', results: results.slice(0, 8) };
  }

  async geocode(address = '') {
    const coordinates = this.parseCoordinates(address);
    const key = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    if (key && address.trim().length >= 2) {
      const google = coordinates
        ? await this.googleReverseGeocode(coordinates.latitude, coordinates.longitude, key).catch(() => null)
        : await this.googleGeocode(address, key).catch(() => null);
      if (google) return { provider: 'google', result: google };
    }

    if (coordinates) {
      const formatted = `${coordinates.latitude.toFixed(5)}, ${coordinates.longitude.toFixed(5)}`;
      return {
        provider: 'coordinate',
        result: {
          id: `current-${formatted}`,
          label: 'Current location',
          address: `Current GPS location - ${formatted}`,
          city: '',
          state: '',
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          provider: 'coordinate',
        },
      };
    }

    const normalized = address.trim().toLowerCase();
    const result =
      PREVIEW_PLACES.find((place) => `${place.label} ${place.address}`.toLowerCase().includes(normalized)) ??
      PREVIEW_PLACES[0];

    return { provider: 'mock', result };
  }

  async routeEstimate(input: RouteEstimateInput): Promise<RouteQuote> {
    const adjustments = await this.pricingAdjustments();
    const normalizedInput = this.normalizeQuoteInput(input);
    const { originLatitude, originLongitude, destinationLatitude, destinationLongitude } = normalizedInput;
    const googleKey = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    const liveRoute = googleKey && [originLatitude, originLongitude, destinationLatitude, destinationLongitude].every(Number.isFinite)
      ? await this.googleRoute(
          originLatitude,
          originLongitude,
          destinationLatitude,
          destinationLongitude,
          googleKey,
        ).catch(() => null)
      : null;
    const straightKm = this.distanceKm(
      originLatitude,
      originLongitude,
      destinationLatitude,
      destinationLongitude,
    );
    const distanceKm = liveRoute?.distanceKm ?? Math.max(1, straightKm * ROAD_FACTOR);
    const durationMinutes = liveRoute?.durationMinutes ?? Math.max(30, Math.round((distanceKm / AVERAGE_SPEED_KMH) * 60));
    const profile = this.truckProfile(normalizedInput.truckType, adjustments);
    const safeWeight = normalizedInput.weightTons;
    const safeVolume = normalizedInput.volumeM3;
    if (safeWeight > profile.capacityTons) {
      throw new BadRequestException(`${profile.label} supports up to ${profile.capacityTons} tons. Select a larger truck or reduce the cargo weight.`);
    }
    if (safeVolume > profile.capacityM3) {
      throw new BadRequestException(`${profile.label} provides up to ${profile.capacityM3} cubic metres. Select a larger truck or reduce the cargo volume.`);
    }
    const weightUtilization = safeWeight / profile.capacityTons;
    const volumeUtilization = safeVolume > 0 ? safeVolume / profile.capacityM3 : 0;
    const loadUtilization = Math.max(weightUtilization, volumeUtilization);
    // A customer reserves the whole truck, so a light load cannot be priced as if only
    // the cargo moved itself. The route component starts at 65% and rises linearly to
    // 100% at full capacity; the fixed base/minimum fare still covers dispatch costs.
    const loadMultiplier = 0.65 + 0.35 * Math.min(loadUtilization, 1);
    const distancePricing = this.distancePricing(distanceKm);
    const linehaulNgn = distanceKm * profile.perKmRateNgn * distancePricing.multiplier * loadMultiplier;
    const fuelSurchargeNgn = Math.round(linehaulNgn * (adjustments.pricingFuelSurchargePercent / 100));
    const tollAllowanceNgn = adjustments.pricingTollAllowanceNgn;
    const preSurgeSubtotalNgn = profile.baseFareNgn + linehaulNgn + fuelSurchargeNgn + tollAllowanceNgn;
    const demandSurgeNgn = Math.round(preSurgeSubtotalNgn * (adjustments.pricingDemandSurgePercent / 100));
    const subtotalNgn = preSurgeSubtotalNgn + demandSurgeNgn;
    const serviceFeeNgn = Math.round(subtotalNgn * (adjustments.pricingServiceFeePercent / 100));
    const quotedPriceKobo = Math.max(profile.minimumFareNgn * 100, Math.round((subtotalNgn + serviceFeeNgn) * 100));
    const roundedDistanceKm = Number(distanceKm.toFixed(1));

    const quote: RouteQuoteCore = {
      provider: liveRoute ? 'google' : 'coordinate',
      distanceKm: roundedDistanceKm,
      durationMinutes,
      quotedPriceKobo,
      currency: 'NGN',
      pricingMode: liveRoute ? 'live_road_route' : 'coordinate_estimate',
      pricingVersion: PRICING_VERSION,
      quoteValidMinutes: adjustments.pricingQuoteValidityMinutes,
      pricingBreakdown: {
        baseFareKobo: profile.baseFareNgn * 100,
        linehaulKobo: Math.round(linehaulNgn * 100),
        escrowFeeKobo: serviceFeeNgn * 100,
        fuelSurchargeKobo: fuelSurchargeNgn * 100,
        tollAllowanceKobo: tollAllowanceNgn * 100,
        demandSurgeKobo: demandSurgeNgn * 100,
        perKmRateKobo: profile.perKmRateNgn * 100,
        roadFactor: liveRoute ? 1 : ROAD_FACTOR,
        routeSource: liveRoute ? 'google_routes' : 'coordinate_factor',
        averageSpeedKmh: AVERAGE_SPEED_KMH,
        weightTons: safeWeight,
        weightMultiplier: Number(loadMultiplier.toFixed(2)),
        loadMultiplier: Number(loadMultiplier.toFixed(2)),
        truckMultiplier: 1,
        truckType: profile.label,
        truckCapacityTons: profile.capacityTons,
        truckCapacityM3: profile.capacityM3,
        volumeM3: safeVolume,
        weightUtilization: Number(weightUtilization.toFixed(3)),
        volumeUtilization: Number(volumeUtilization.toFixed(3)),
        limitingFactor: volumeUtilization > weightUtilization ? 'space' : 'weight',
        loadUtilization: Number(loadUtilization.toFixed(3)),
        distanceBand: distancePricing.band,
        distanceMultiplier: distancePricing.multiplier,
        serviceFeeRate: adjustments.pricingServiceFeePercent / 100,
        fuelSurchargeRate: adjustments.pricingFuelSurchargePercent / 100,
        demandSurgeRate: adjustments.pricingDemandSurgePercent / 100,
      },
    };
    const quoteExpiresAt = new Date(Date.now() + adjustments.pricingQuoteValidityMinutes * 60_000).toISOString();
    return {
      ...quote,
      quoteExpiresAt,
      quoteToken: this.signQuote({ input: normalizedInput, quote, expiresAt: quoteExpiresAt }),
    };
  }

  verifyQuoteToken(token: string, input: RouteEstimateInput): RouteQuote {
    const [encodedPayload, suppliedSignature] = token.split('.');
    if (!encodedPayload || !suppliedSignature) throw new BadRequestException('This quote is invalid. Request a new quote.');
    const expectedSignature = this.quoteSignature(encodedPayload);
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new BadRequestException('This quote is invalid. Request a new quote.');
    }
    let payload: SignedQuotePayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedQuotePayload;
    } catch {
      throw new BadRequestException('This quote is invalid. Request a new quote.');
    }
    if (!payload.expiresAt || new Date(payload.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('This quote has expired. Request a new quote.');
    }
    if (JSON.stringify(payload.input) !== JSON.stringify(this.normalizeQuoteInput(input))) {
      throw new BadRequestException('Shipment details changed after the quote. Request a new quote.');
    }
    if (!payload.quote || !Number.isFinite(payload.quote.quotedPriceKobo) || payload.quote.quotedPriceKobo <= 0) {
      throw new BadRequestException('This quote is invalid. Request a new quote.');
    }
    return { ...payload.quote, quoteExpiresAt: payload.expiresAt, quoteToken: token };
  }

  private normalizeQuoteInput(input: RouteEstimateInput): NormalizedQuoteInput {
    const normalizeCoordinate = (value: number | undefined, fallback: number) => Number(Number(value ?? fallback).toFixed(6));
    const weight = Number.isFinite(input.weightTons) && Number(input.weightTons) > 0 ? Number(input.weightTons) : 1;
    const volume = Number.isFinite(input.volumeM3) && Number(input.volumeM3) > 0 ? Number(input.volumeM3) : 0;
    return {
      originLatitude: normalizeCoordinate(input.originLatitude, 6.5244),
      originLongitude: normalizeCoordinate(input.originLongitude, 3.3792),
      destinationLatitude: normalizeCoordinate(input.destinationLatitude, 9.0765),
      destinationLongitude: normalizeCoordinate(input.destinationLongitude, 7.3986),
      truckType: String(input.truckType ?? 'truck').trim().toLowerCase(),
      weightTons: Number(weight.toFixed(3)),
      volumeM3: Number(volume.toFixed(3)),
    };
  }

  private signQuote(payload: SignedQuotePayload) {
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encodedPayload}.${this.quoteSignature(encodedPayload)}`;
  }

  private quoteSignature(encodedPayload: string) {
    // 'JWT_SECRET' here was never a real configured variable anywhere in this codebase
    // (the actual one is JWT_ACCESS_SECRET) - so in any environment without a dedicated
    // QUOTE_SIGNING_SECRET, this always fell through to the hardcoded fallback string,
    // which is sitting in plaintext in the public repo. That defeats the entire point of
    // signing: anyone reading the source could compute a valid signature for a tampered
    // quote (e.g. an artificially low price) themselves. Falling back to the real,
    // already-required JWT_ACCESS_SECRET keeps this genuinely unguessable even before a
    // dedicated QUOTE_SIGNING_SECRET is provisioned.
    const secret = this.config.get<string>('QUOTE_SIGNING_SECRET')
      ?? this.config.get<string>('JWT_ACCESS_SECRET')
      ?? 'tracko-development-quote-secret';
    return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  }

  private async pricingAdjustments() {
    const keys = Object.keys(PRICING_SETTING_DEFAULTS);
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: keys } },
      select: { key: true, value: true },
    }).catch(() => []);
    const configured = new Map(rows.map((row) => [row.key, Number(row.value)]));
    return Object.fromEntries(
      Object.entries(PRICING_SETTING_DEFAULTS).map(([key, fallback]) => {
        const value = configured.get(key);
        return [key, Number.isFinite(value) ? value : fallback];
      }),
    ) as Record<string, number>;
  }

  private async googleRoute(
    originLatitude: number,
    originLongitude: number,
    destinationLatitude: number,
    destinationLongitude: number,
    key: string,
  ) {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: originLatitude, longitude: originLongitude } } },
        destination: { location: { latLng: { latitude: destinationLatitude, longitude: destinationLongitude } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        computeAlternativeRoutes: false,
        languageCode: 'en-NG',
        units: 'METRIC',
      }),
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      routes?: Array<{ distanceMeters?: number; duration?: string }>;
    };
    const route = payload.routes?.[0];
    const distanceMeters = Number(route?.distanceMeters);
    const durationSeconds = Number.parseFloat(String(route?.duration ?? '').replace(/s$/, ''));
    if (!Number.isFinite(distanceMeters) || distanceMeters <= 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }
    return {
      distanceKm: Number((distanceMeters / 1000).toFixed(1)),
      durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
    };
  }

  private truckProfile(truckType: string | undefined, adjustments: Record<string, number>) {
    const normalizedTruckType = (truckType ?? '').toLowerCase();
    const key = Object.keys(TRUCK_PRICING).find((candidate) => normalizedTruckType.includes(candidate)) ?? 'truck';
    const defaults = TRUCK_PRICING[key];
    // Only the five carded classes are admin-tunable; everything else uses its fixed rate.
    if (!ADMIN_TUNED_KEYS.has(key)) return { ...defaults };
    const prefix = key === 'truck' ? 'Standard' : key.charAt(0).toUpperCase() + key.slice(1);
    return {
      ...defaults,
      baseFareNgn: adjustments[`pricing${prefix}BaseFareNgn`] ?? defaults.baseFareNgn,
      perKmRateNgn: adjustments[`pricing${prefix}PerKmRateNgn`] ?? defaults.perKmRateNgn,
      minimumFareNgn: adjustments[`pricing${prefix}MinimumFareNgn`] ?? defaults.minimumFareNgn,
    };
  }

  private distancePricing(distanceKm: number) {
    // Short local runs carry a handling premium; regional trips are the reference
    // rate; long haul tapers smoothly toward 0.8x by ~1500 km (fuel and driver
    // cost per km fall the longer the trip), instead of one flat long-haul step.
    if (distanceKm <= 60) return { band: 'LOCAL', multiplier: 1.15 };
    if (distanceKm <= 200) return { band: 'REGIONAL', multiplier: 1 };
    const taper = Math.min(1, (distanceKm - 200) / 1300);
    return { band: 'LONG_HAUL', multiplier: Number((1 - 0.2 * taper).toFixed(3)) };
  }

  private async googlePlaces(query: string, key: string): Promise<PlaceSuggestion[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.searchParams.set('query', `${query}, Nigeria`);
    url.searchParams.set('key', key);
    const response = await fetch(url);
    const payload = (await response.json()) as {
      results?: Array<{ place_id: string; name: string; formatted_address: string; geometry?: { location?: { lat: number; lng: number } } }>;
    };

    return (payload.results ?? []).slice(0, 8).map((item) => ({
      id: item.place_id,
      label: item.name,
      address: item.formatted_address,
      city: this.cityFromAddress(item.formatted_address),
      state: '',
      latitude: item.geometry?.location?.lat ?? 0,
      longitude: item.geometry?.location?.lng ?? 0,
      provider: 'google',
    }));
  }

  private async googleGeocode(address: string, key: string): Promise<PlaceSuggestion | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', `${address}, Nigeria`);
    url.searchParams.set('key', key);
    const response = await fetch(url);
    const payload = (await response.json()) as {
      results?: Array<{ place_id: string; formatted_address: string; geometry?: { location?: { lat: number; lng: number } } }>;
    };
    const result = payload.results?.[0];
    if (!result) return null;

    return {
      id: result.place_id,
      label: this.cityFromAddress(result.formatted_address),
      address: result.formatted_address,
      city: this.cityFromAddress(result.formatted_address),
      state: '',
      latitude: result.geometry?.location?.lat ?? 0,
      longitude: result.geometry?.location?.lng ?? 0,
      provider: 'google',
    };
  }

  private async googleReverseGeocode(latitude: number, longitude: number, key: string): Promise<PlaceSuggestion | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${latitude},${longitude}`);
    url.searchParams.set('result_type', 'street_address|route|premise|sublocality|locality');
    url.searchParams.set('key', key);
    const response = await fetch(url);
    const payload = (await response.json()) as {
      results?: Array<{ place_id: string; formatted_address: string; geometry?: { location?: { lat: number; lng: number } } }>;
    };
    const result = payload.results?.[0];
    if (!result) return null;

    return {
      id: result.place_id,
      label: this.cityFromAddress(result.formatted_address),
      address: result.formatted_address,
      city: this.cityFromAddress(result.formatted_address),
      state: '',
      latitude: result.geometry?.location?.lat ?? latitude,
      longitude: result.geometry?.location?.lng ?? longitude,
      provider: 'google',
    };
  }

  private parseCoordinates(value: string) {
    const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return null;
    }
    return { latitude, longitude };
  }

  private cityFromAddress(address: string) {
    return address.split(',').map((part) => part.trim()).filter(Boolean)[0] ?? 'Address';
  }

  private distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const earthKm = 6371;
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRadians(value: number) {
    return (value * Math.PI) / 180;
  }
}
