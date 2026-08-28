import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
const PRICING_VERSION = '2026-08-admin-1';

const PRICING_SETTING_DEFAULTS = {
  pricingServiceFeePercent: 3.5,
  pricingFuelSurchargePercent: 0,
  pricingTollAllowanceNgn: 0,
  pricingDemandSurgePercent: 0,
  pricingQuoteValidityMinutes: 30,
} as const;

type TruckPricingProfile = {
  label: string;
  capacityTons: number;
  baseFareNgn: number;
  perKmRateNgn: number;
  minimumFareNgn: number;
};

const TRUCK_PRICING: Record<string, TruckPricingProfile> = {
  flatbed: { label: 'Flatbed', capacityTons: 30, baseFareNgn: 55_000, perKmRateNgn: 720, minimumFareNgn: 95_000 },
  box: { label: 'Box truck', capacityTons: 15, baseFareNgn: 50_000, perKmRateNgn: 680, minimumFareNgn: 90_000 },
  tipper: { label: 'Tipper', capacityTons: 30, baseFareNgn: 60_000, perKmRateNgn: 760, minimumFareNgn: 100_000 },
  tanker: { label: 'Tanker', capacityTons: 33, baseFareNgn: 70_000, perKmRateNgn: 820, minimumFareNgn: 115_000 },
  truck: { label: 'Standard truck', capacityTons: 20, baseFareNgn: 50_000, perKmRateNgn: 700, minimumFareNgn: 90_000 },
};

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
    const key = this.config.get<string>('GOOGLE_MAPS_API_KEY');
    if (key && address.trim().length >= 2) {
      const google = await this.googleGeocode(address, key).catch(() => null);
      if (google) return { provider: 'google', result: google };
    }

    const normalized = address.trim().toLowerCase();
    const result =
      PREVIEW_PLACES.find((place) => `${place.label} ${place.address}`.toLowerCase().includes(normalized)) ??
      PREVIEW_PLACES[0];

    return { provider: 'mock', result };
  }

  async routeEstimate(input: {
    originLatitude?: number;
    originLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
    truckType?: string;
    weightTons?: number;
  }) {
    const adjustments = await this.pricingAdjustments();
    const straightKm = this.distanceKm(
      Number(input.originLatitude ?? 6.5244),
      Number(input.originLongitude ?? 3.3792),
      Number(input.destinationLatitude ?? 9.0765),
      Number(input.destinationLongitude ?? 7.3986),
    );
    const distanceKm = Math.max(1, straightKm * ROAD_FACTOR);
    const durationMinutes = Math.max(30, Math.round((distanceKm / AVERAGE_SPEED_KMH) * 60));
    const profile = this.truckProfile(input.truckType);
    const safeWeight = Number.isFinite(input.weightTons) && Number(input.weightTons) > 0
      ? Number(input.weightTons)
      : 1;
    if (safeWeight > profile.capacityTons) {
      throw new BadRequestException(`${profile.label} supports up to ${profile.capacityTons} tons. Select a larger truck or reduce the cargo weight.`);
    }
    const loadUtilization = safeWeight / profile.capacityTons;
    const weightMultiplier = 0.75 + 0.35 * Math.min(loadUtilization, 1);
    const distancePricing = this.distancePricing(distanceKm);
    const linehaulNgn = distanceKm * profile.perKmRateNgn * distancePricing.multiplier * weightMultiplier;
    const fuelSurchargeNgn = Math.round(linehaulNgn * (adjustments.pricingFuelSurchargePercent / 100));
    const tollAllowanceNgn = adjustments.pricingTollAllowanceNgn;
    const preSurgeSubtotalNgn = profile.baseFareNgn + linehaulNgn + fuelSurchargeNgn + tollAllowanceNgn;
    const demandSurgeNgn = Math.round(preSurgeSubtotalNgn * (adjustments.pricingDemandSurgePercent / 100));
    const subtotalNgn = preSurgeSubtotalNgn + demandSurgeNgn;
    const serviceFeeNgn = Math.round(subtotalNgn * (adjustments.pricingServiceFeePercent / 100));
    const quotedPriceKobo = Math.max(profile.minimumFareNgn * 100, Math.round((subtotalNgn + serviceFeeNgn) * 100));
    const roundedDistanceKm = Number(distanceKm.toFixed(1));

    return {
      provider: 'coordinate',
      distanceKm: roundedDistanceKm,
      durationMinutes,
      quotedPriceKobo,
      currency: 'NGN',
      pricingMode: 'coordinate_estimate',
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
        roadFactor: ROAD_FACTOR,
        averageSpeedKmh: AVERAGE_SPEED_KMH,
        weightTons: safeWeight,
        weightMultiplier: Number(weightMultiplier.toFixed(2)),
        truckMultiplier: 1,
        truckType: profile.label,
        truckCapacityTons: profile.capacityTons,
        loadUtilization: Number(loadUtilization.toFixed(3)),
        distanceBand: distancePricing.band,
        distanceMultiplier: distancePricing.multiplier,
        serviceFeeRate: adjustments.pricingServiceFeePercent / 100,
        fuelSurchargeRate: adjustments.pricingFuelSurchargePercent / 100,
        demandSurgeRate: adjustments.pricingDemandSurgePercent / 100,
      },
    };
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
    ) as Record<keyof typeof PRICING_SETTING_DEFAULTS, number>;
  }

  private truckProfile(truckType = '') {
    const key = Object.keys(TRUCK_PRICING).find((candidate) => truckType.toLowerCase().includes(candidate)) ?? 'truck';
    return TRUCK_PRICING[key];
  }

  private distancePricing(distanceKm: number) {
    if (distanceKm <= 50) return { band: 'LOCAL', multiplier: 1.15 };
    if (distanceKm <= 300) return { band: 'REGIONAL', multiplier: 1 };
    return { band: 'LONG_HAUL', multiplier: 0.9 };
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
