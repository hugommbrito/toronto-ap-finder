/**
 * Google Maps deep links, mirrored from src/notifications/message.ts.
 *
 * Kept as a copy rather than shared: the shared types file must stay import-free, and these ten
 * lines are the whole of it. If the message changes how it links, change this too.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

/** No API key and no billing: the URL scheme is a documented, free product. */
export function walkingRouteUrl(from: LatLng, to: LatLng): string {
  return (
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat}%2C${from.lng}` +
    `&destination=${to.lat}%2C${to.lng}&travelmode=walking`
  );
}

/** Google Maps caps waypoints at three on mobile browsers, where this link is opened. */
export const MAX_MAP_STOPS = 3;

/** One map with the listing and everything that matters around it — a round trip, so every pin shows. */
export function overviewMapUrl(home: LatLng, stops: LatLng[]): string | null {
  const chosen = stops.slice(0, MAX_MAP_STOPS);
  if (chosen.length === 0) return null;
  const point = (p: LatLng): string => `${p.lat}%2C${p.lng}`;
  const waypoints = chosen.map(point).join('%7C');
  return (
    `https://www.google.com/maps/dir/?api=1&origin=${point(home)}&destination=${point(home)}` +
    `&waypoints=${waypoints}&travelmode=walking`
  );
}
