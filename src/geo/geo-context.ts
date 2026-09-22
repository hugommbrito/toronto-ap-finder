import { daycareCoverageOf } from '@/geo/coverage';
import type { TenantProfile } from '@/profiles/profile.schema';
import { reachableLines, type GeoIndex } from '@/scoring/context';
import type { GeoContext, MapPoints, MapSurroundings } from '@/ui-api/api-types';

/** The three listing fields the geography needs. A `TriageListing` satisfies it. */
export interface GeoSubject {
  lat: number | null;
  lng: number | null;
  city: string | null;
}

/**
 * Beyond the transit decay distance the score is zero anyway, so nothing further is
 * "reachable" as far as this profile is concerned.
 */
export function transitRadiusOf(profile: TenantProfile): number {
  return profile.soft.transitWalkZeroM ?? profile.hard.maxTransitWalkM ?? 900;
}

/**
 * The geographic facts about a listing, as the notification states them.
 *
 * One function feeding both the Telegram message and the web page, because they must never
 * disagree: if the message says two daycares and the page says three, one of them is lying and
 * the reader cannot tell which. Nothing here is persisted — it is recomputed from the in-memory
 * GeoIndex each time, which is cheap, and it means a seed refresh corrects every past listing.
 */
export function geoContextFor(listing: GeoSubject, profile: TenantProfile, geo: GeoIndex): GeoContext {
  const cfg = profile.hard.minDaycaresWithin;
  const radiusM = cfg?.radiusM ?? 800;
  const transitRadiusM = transitRadiusOf(profile);

  if (listing.lat === null || listing.lng === null) {
    return {
      reachableLines: [],
      transitRadiusM,
      // Nothing was searched — there is no point to search from. Claiming 'full' here made the
      // message print "0 toddler daycares within 800 m", which is a measurement nobody took.
      daycaresNearby: { total: 0, cwelcc: 0, radiusM, coverage: 'none' },
      nearestDaycare: null,
      mapStops: [],
    };
  }
  const point = { lat: listing.lat, lng: listing.lng };
  /**
   * Counted the same way the hard filter counted, or the message contradicts the decision.
   *
   * Strictly, a Mississauga listing has no centre with a *confirmed* toddler place, so the
   * strict query returns zero — and a notification reading "0 toddler daycares within 800 m"
   * on an ad that passed the childcare filter is worse than useless.
   */
  const reaches = daycareCoverageOf(listing.city) !== 'none';
  // daycaresWithin already returns them sorted by distance, so the first is the closest.
  const nearby =
    cfg && reaches ? geo.daycaresWithin(point, radiusM, cfg.ageGroup, { acceptUnknownCapacity: true }) : [];
  /**
   * Follows the centres counted, so the wording matches the verdict the filter reached.
   * A Mississauga listing whose one centre is a published Toronto row gets Toronto's phrasing,
   * because that is what was actually measured.
   */
  const coverage: 'full' | 'presenceOnly' | 'none' = !reaches
    ? 'none'
    : nearby.every((n) => n.daycare.capacityKnown)
      ? 'full'
      : 'presenceOnly';
  const closest = nearby[0];
  const lines = reachableLines(geo.stationsWithin(point, transitRadiusM, 'operational'));
  // Nearest station first, then the closest daycares: with only three slots, the station is
  // the one point the daycare count cannot stand in for.
  const mapStops = [
    ...lines.slice(0, 1).map((l) => ({ label: l.station, lat: l.lat, lng: l.lng })),
    ...nearby.slice(0, 3).map((n) => ({ label: n.daycare.name, lat: n.daycare.lat, lng: n.daycare.lng })),
  ];

  return {
    reachableLines: lines,
    transitRadiusM,
    mapStops,
    daycaresNearby: {
      total: nearby.length,
      cwelcc: nearby.filter((n) => n.daycare.cwelcc).length,
      radiusM,
      coverage,
    },
    nearestDaycare: closest
      ? {
          name: closest.daycare.name,
          distanceM: closest.distanceM,
          cwelcc: closest.daycare.cwelcc,
          lat: closest.daycare.lat,
          lng: closest.daycare.lng,
        }
      : null,
  };
}

/**
 * The three facts the map's mini-card has room for, taken from a context rather than recomputed,
 * so the card can only ever say a subset of what the detail says.
 */
export function surroundingsOf(ctx: GeoContext): MapSurroundings {
  return {
    reachableLines: ctx.reachableLines,
    nearestDaycare: ctx.nearestDaycare,
    daycareCoverage: ctx.daycaresNearby.coverage,
  };
}

/**
 * Every point the map should draw, with coordinates: stations within the transit radius,
 * operational and future alike, and the daycares the context counted. Same queries as
 * `geoContextFor`, so what is drawn is what was measured.
 */
export function mapPointsFor(listing: GeoSubject, profile: TenantProfile, geo: GeoIndex): MapPoints | null {
  if (listing.lat === null || listing.lng === null) return null;
  const point = { lat: listing.lat, lng: listing.lng };
  const transitRadiusM = transitRadiusOf(profile);
  const cfg = profile.hard.minDaycaresWithin;
  const radiusM = cfg?.radiusM ?? 800;
  const reaches = daycareCoverageOf(listing.city) !== 'none';

  const nearby =
    cfg && reaches ? geo.daycaresWithin(point, radiusM, cfg.ageGroup, { acceptUnknownCapacity: true }) : [];
  const stations = [
    ...geo.stationsWithin(point, transitRadiusM, 'operational'),
    ...geo.stationsWithin(point, transitRadiusM, 'future'),
  ];

  return {
    stations: stations.map(({ station, distanceM }) => ({
      id: station.id,
      name: station.name,
      line: station.line,
      status: station.status,
      expectedYear: station.expectedYear,
      lat: station.lat,
      lng: station.lng,
      distanceM,
    })),
    daycares: nearby.map(({ daycare, distanceM }) => ({
      id: daycare.id,
      name: daycare.name,
      lat: daycare.lat,
      lng: daycare.lng,
      distanceM,
      cwelcc: daycare.cwelcc,
      capacityKnown: daycare.capacityKnown,
    })),
  };
}
