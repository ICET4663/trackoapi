import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

@Injectable()
export class MapsProviderService {
  constructor(private readonly config: ConfigService) {}

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

  routeEstimate(input: {
    originLatitude?: number;
    originLongitude?: number;
    destinationLatitude?: number;
    destinationLongitude?: number;
    truckType?: string;
  }) {
    const distanceKm = this.distanceKm(
      Number(input.originLatitude ?? 6.5244),
      Number(input.originLongitude ?? 3.3792),
      Number(input.destinationLatitude ?? 9.0765),
      Number(input.destinationLongitude ?? 7.3986),
    );
    const durationMinutes = Math.max(30, Math.round((distanceKm / 55) * 60));
    const baseKobo = Math.round(distanceKm * 850 * 100);
    const truckMultiplier = /tipper|flatbed/i.test(input.truckType ?? '') ? 1.15 : 1;
    const quotedPriceKobo = Math.max(8500000, Math.round(baseKobo * truckMultiplier));

    return {
      provider: this.status().provider,
      distanceKm: Number(distanceKm.toFixed(1)),
      durationMinutes,
      quotedPriceKobo,
      currency: 'NGN',
      pricingMode: 'estimate',
    };
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
