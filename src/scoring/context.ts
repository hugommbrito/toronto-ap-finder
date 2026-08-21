import type { DaycareAgeGroup, TenantProfile } from '@/profiles/profile.schema';
import { walkingMeters, type LatLng } from '@/geo/distance';

export interface DaycarePoint extends LatLng {
  id: string;
  name: string;
  infantSpace: number;
  toddlerSpace: number;
  preschoolSpace: number;
  kindergartenSpace: number;
  schoolageSpace: number;
  subsidy: boolean;
  cwelcc: boolean;
}

export interface TransitPoint extends LatLng {
  id: string;
  name: string;
  line: string;
  status: 'operational' | 'future';
  expectedYear: number | null;
}

/** The listing fields scoring actually reads. Keeps components testable without a database. */
export interface ScorableListing {
  totalMonthlyCost: number;
  /** Whole bedrooms. A "2 + den" unit is beds: 2, dens: 1. */
  beds: number | null;
  dens: number;
  lat: number | null;
  lng: number | null;
  hasLocker: boolean | null;
  inSuiteLaundry: boolean | null;
  buildingBuiltBefore2018: boolean | null;
}

const AGE_GROUP_COLUMN: Record<DaycareAgeGroup, keyof DaycarePoint> = {
  infant: 'infantSpace',
  toddler: 'toddlerSpace',
  preschool: 'preschoolSpace',
  kindergarten: 'kindergartenSpace',
  schoolage: 'schoolageSpace',
};

export function hasCapacityFor(daycare: DaycarePoint, ageGroup: DaycareAgeGroup): boolean {
  return (daycare[AGE_GROUP_COLUMN[ageGroup]] as number) > 0;
}

export interface NearbyDaycare {
  daycare: DaycarePoint;
  distanceM: number;
}

export interface NearbyStation {
  station: TransitPoint;
  distanceM: number;
}

/**
 * Snapshot of the seeded geography, held in memory. ~1,090 daycares and ~70 stations is
 * well under 100 KB, so a linear scan is faster than a round trip to Postgres and — more
 * importantly — lets every scoring component be unit-tested without a database.
 *
 * All distances are walking distances (haversine x 1.3), so a radius of 800 m means
 * "800 m of pavement", not 800 m as the crow flies.
 */
export class GeoIndex {
  constructor(
    private readonly daycares: DaycarePoint[],
    private readonly stations: TransitPoint[],
  ) {}

  daycaresWithin(origin: LatLng, radiusM: number, ageGroup: DaycareAgeGroup): NearbyDaycare[] {
    const out: NearbyDaycare[] = [];
    for (const daycare of this.daycares) {
      if (!hasCapacityFor(daycare, ageGroup)) continue;
      const distanceM = walkingMeters(origin, daycare);
      if (distanceM <= radiusM) out.push({ daycare, distanceM });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }

  stationsWithin(origin: LatLng, radiusM: number, status: 'operational' | 'future'): NearbyStation[] {
    const out: NearbyStation[] = [];
    for (const station of this.stations) {
      if (station.status !== status) continue;
      const distanceM = walkingMeters(origin, station);
      if (distanceM <= radiusM) out.push({ station, distanceM });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }

  nearestStation(origin: LatLng, status: 'operational' | 'future'): NearbyStation | null {
    let best: NearbyStation | null = null;
    for (const station of this.stations) {
      if (station.status !== status) continue;
      const distanceM = walkingMeters(origin, station);
      if (best === null || distanceM < best.distanceM) best = { station, distanceM };
    }
    return best;
  }

  get daycareCount(): number {
    return this.daycares.length;
  }

  get stationCount(): number {
    return this.stations.length;
  }
}

export interface ReachableLine {
  /** e.g. 'Line 4 Sheppard'. */
  line: string;
  /** The closest station serving that line. */
  station: string;
  distanceM: number;
  /** Where that station is, so a walking route can be linked. */
  lat: number;
  lng: number;
}

/**
 * Which lines are reachable on foot, and via which station.
 *
 * Counting stations would be the wrong shape. Daycare redundancy matters because of waiting
 * lists — four centres genuinely beat one. Nobody queues for a subway, so a second station
 * on a line already covered adds nothing; what changes where you can actually go is a
 * *different line*. Two listings each with "1 station nearby" can mean Line 1 or Line 4,
 * and the message should say which.
 *
 * Interchanges are stored with their lines joined by ' / ', so one station can serve several.
 */
export function reachableLines(nearby: NearbyStation[]): ReachableLine[] {
  const closest = new Map<string, ReachableLine>();

  for (const { station, distanceM } of nearby) {
    for (const line of station.line.split(' / ').map((l) => l.trim()).filter(Boolean)) {
      const existing = closest.get(line);
      if (!existing || distanceM < existing.distanceM) {
        closest.set(line, { line, station: station.name, distanceM, lat: station.lat, lng: station.lng });
      }
    }
  }

  return [...closest.values()].sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * The City's inspection record for the building a listing is in, when one could be established.
 *
 * Optional on the context rather than required: every existing spec constructs a context, and a
 * required field would have made adding this a rewrite of files it has nothing to do with.
 */
export interface ScoredBuilding {
  rsn: string;
  score: number;
  yearBuilt: number | null;
}

export interface ScoringContext {
  /** Null when no inspected building could be matched, which is most condo listings. */
  building?: ScoredBuilding | null;
  listing: ScorableListing;
  profile: TenantProfile;
  geo: GeoIndex;
}

/**
 * A component returns 0..1, or null when it cannot know.
 *
 * Null is not zero. A null component is dropped from both the numerator and the
 * denominator, so an ad that simply does not mention a locker is not punished as though
 * it had no locker — it just gets scored on what is actually known about it.
 */
export type ScoreComponent = (ctx: ScoringContext) => number | null;

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 1.0 at or below `full`, falling linearly to 0 at `zero`. */
export function linearDecay(distance: number, full: number, zero: number): number {
  if (zero <= full) return distance <= full ? 1 : 0;
  return clamp01((zero - distance) / (zero - full));
}
