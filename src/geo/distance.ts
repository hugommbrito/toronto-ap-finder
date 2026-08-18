export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Straight-line distance in metres. At the 400-900 m radii this project uses, the error
 * against a geodesic is centimetres — running a routing engine would not change a decision.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Toronto's street grid means walking is roughly 30% longer than the crow flies.
 * Cheap and good enough; OSRM is not justified at this stage.
 */
export const WALKING_DETOUR_FACTOR = 1.3;

export function walkingMeters(a: LatLng, b: LatLng): number {
  return haversineMeters(a, b) * WALKING_DETOUR_FACTOR;
}
