import { distanceKm, isReturnLoad, RETURN_LOAD_RADIUS_KM, returnLoadBonus, returnLoadDistanceKm } from './return-load';

describe('return-load helpers', () => {
  it('measures Lagos to Abuja at about 530 km', () => {
    const km = distanceKm(6.5244, 3.3792, 9.0765, 7.3986);
    expect(km).toBeGreaterThan(510);
    expect(km).toBeLessThan(550);
  });

  it('gives no distance when a coordinate is missing or not a number', () => {
    expect(distanceKm(null, 3.3, 9, 7)).toBeNull();
    expect(distanceKm(6.5, undefined, 9, 7)).toBeNull();
    expect(distanceKm(6.5, 3.3, Number.NaN, 7)).toBeNull();
    expect(returnLoadDistanceKm(null, { pickupLatitude: 9, pickupLongitude: 7 })).toBeNull();
    expect(returnLoadDistanceKm({ destinationLatitude: 9, destinationLongitude: 7 }, { pickupLatitude: null, pickupLongitude: 7 })).toBeNull();
  });

  it('measures from the trip destination to the new pickup', () => {
    const km = returnLoadDistanceKm(
      { destinationLatitude: 9.0333, destinationLongitude: 7.4891 },
      { pickupLatitude: 9.0765, pickupLongitude: 7.3986 },
    );
    expect(km).toBeGreaterThan(9);
    expect(km).toBeLessThan(12);
  });

  it('counts a return load up to the radius and ranks closer ones higher', () => {
    expect(isReturnLoad(null)).toBe(false);
    expect(isReturnLoad(RETURN_LOAD_RADIUS_KM)).toBe(true);
    expect(isReturnLoad(RETURN_LOAD_RADIUS_KM + 0.1)).toBe(false);
    expect(returnLoadBonus(5)).toBe(25);
    expect(returnLoadBonus(20)).toBe(20);
    expect(returnLoadBonus(40)).toBe(15);
    expect(returnLoadBonus(80)).toBe(0);
    expect(returnLoadBonus(null)).toBe(0);
  });
});
