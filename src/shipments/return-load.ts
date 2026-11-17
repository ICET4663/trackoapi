// Return-load matching: a driver whose current trip ends near a new load's pickup can take
// that load next instead of driving back empty. Both the dispatcher's assignment queue
// (OperationsService) and automatic dispatch (ShipmentsService) use these helpers, so the
// two always agree on what counts as a return load.

/** A new pickup within this straight-line distance of where a trip ends is a return load. */
export const RETURN_LOAD_RADIUS_KM = 50;

type Coordinate = number | null | undefined;

/** Great-circle distance in km, or null when any coordinate is missing or not a number. */
export function distanceKm(fromLatitude: Coordinate, fromLongitude: Coordinate, toLatitude: Coordinate, toLongitude: Coordinate) {
  const values = [fromLatitude, fromLongitude, toLatitude, toLongitude];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(toLatitude! - fromLatitude!);
  const longitudeDelta = radians(toLongitude! - fromLongitude!);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(fromLatitude!)) * Math.cos(radians(toLatitude!)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * Distance from the end of the driver's current trip to the new load's pickup, or null when
 * either place has no map position. Unlike the driver's live GPS this never goes stale: it is
 * where the driver will be when the current trip is done.
 */
export function returnLoadDistanceKm(
  activeTrip: { destinationLatitude?: Coordinate; destinationLongitude?: Coordinate } | null | undefined,
  pickup: { pickupLatitude?: Coordinate; pickupLongitude?: Coordinate },
) {
  if (!activeTrip) return null;
  return distanceKm(activeTrip.destinationLatitude, activeTrip.destinationLongitude, pickup.pickupLatitude, pickup.pickupLongitude);
}

export function isReturnLoad(distance: number | null) {
  return distance !== null && distance <= RETURN_LOAD_RADIUS_KM;
}

/** Extra ranking points for a return load: closer to the trip's end ranks higher. */
export function returnLoadBonus(distance: number | null) {
  if (!isReturnLoad(distance)) return 0;
  return distance! <= 10 ? 25 : distance! <= 25 ? 20 : 15;
}
