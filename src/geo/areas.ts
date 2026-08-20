import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalMunicipality, normalizeCity } from './city';

/**
 * Which part of Toronto a listing is in — the question the city field cannot answer.
 *
 * Scarborough, East York, North York, Etobicoke and York have been the same municipality as
 * Toronto since 1998, which is exactly why `cityMatches` collapses them onto one another:
 * a source calling a listing "Scarborough" and one calling the same listing "Toronto" are
 * both right. That is the correct behaviour for "anywhere in the 416" and it makes the city
 * allowlist structurally incapable of expressing "the 416 except Scarborough" — dropping
 * Scarborough from the list changes nothing, because the listing still canonicalises to
 * Toronto.
 *
 * So an area cut is decided by position, against the actual 1998 boundaries captured in
 * data/seed/municipal-boundaries.json. The city label is still consulted first, because it
 * is free and it is the only signal available for a listing with no coordinates.
 */
const BOUNDARY_PATH = resolve('data/seed/municipal-boundaries.json');

export interface AreaBoundary {
  name: string;
  /** Closed outer ring, [lng, lat]. */
  ring: [number, number][];
}

interface IndexedArea extends AreaBoundary {
  key: string;
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

interface BoundaryIndex {
  areas: IndexedArea[];
  /** Why the file could not be used, if it could not. Never swallowed — see `excludedAreaOf`. */
  error: string | null;
}

let index: BoundaryIndex | null = null;

function loadIndex(): BoundaryIndex {
  if (index) return index;

  try {
    const parsed = JSON.parse(readFileSync(BOUNDARY_PATH, 'utf8')) as AreaBoundary[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('file contains no boundaries');
    }
    index = { areas: parsed.map(indexArea), error: null };
  } catch (err) {
    index = { areas: [], error: `${BOUNDARY_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }

  return index;
}

/** Test seam. Also the way a caller could point at a different set of boundaries. */
export function setMunicipalBoundaries(boundaries: AreaBoundary[] | null): void {
  index = boundaries === null ? null : { areas: boundaries.map(indexArea), error: null };
}

function indexArea(area: AreaBoundary): IndexedArea {
  const lngs = area.ring.map((v) => v[0]);
  const lats = area.ring.map((v) => v[1]);
  return {
    ...area,
    key: normalizeCity(area.name),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

export interface Point {
  lat: number;
  lng: number;
}

/**
 * Ray casting: count the ring edges crossed by a ray going east from the point.
 *
 * Degrees are used directly rather than projected metres. The test is topological — how
 * many times a boundary is crossed — so the anisotropy of degrees at this latitude cannot
 * change the answer.
 */
function pointInRing(point: Point, area: IndexedArea): boolean {
  if (
    point.lng < area.minLng ||
    point.lng > area.maxLng ||
    point.lat < area.minLat ||
    point.lat > area.maxLat
  ) {
    return false;
  }

  const ring = area.ring;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const straddles = yi > point.lat !== yj > point.lat;
    if (straddles && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }

  return inside;
}

/** The former municipality a point falls in, or null if it is outside all of them. */
export function areaContaining(point: Point): string | null {
  return loadIndex().areas.find((area) => pointInRing(point, area))?.name ?? null;
}

export type AreaVerdict =
  | { kind: 'inside'; area: string; by: 'label' | 'coordinates' }
  | { kind: 'outside' }
  | { kind: 'unknown'; field: string; reason: string };

/**
 * Whether a listing sits in one of the areas a profile refuses.
 *
 * Three outcomes, for the same reason the hard filters have three: an area that cannot be
 * determined must not be allowed to look like an area that is fine. A listing whose
 * position cannot be checked comes back `unknown` and lands in needs_review, so the worst
 * a missing coordinate or a missing boundary file can do is hold a listing back — never
 * quietly deliver the one thing the profile said no to.
 */
export function excludedAreaOf(
  place: { city: string | null; lat: number | null; lng: number | null },
  excluded: readonly string[],
): AreaVerdict {
  if (excluded.length === 0) return { kind: 'outside' };

  // Free, and the only signal for a listing with no coordinates. CAPREIT labels its
  // Scarborough buildings "Scarborough"; Kijiji is happy to call the same block "Toronto".
  const label = normalizeCity(place.city);
  if (label) {
    const named = excluded.find((area) => normalizeCity(area) === label);
    if (named) return { kind: 'inside', area: named, by: 'label' };
  }

  /**
   * Only areas inside today's Toronto need geometry.
   *
   * Brampton is its own municipality: it canonicalises to itself, so no source can call it
   * Toronto by accident and the label above is decisive. Scarborough and East York
   * canonicalise to Toronto, which is precisely why the label proves nothing for them.
   */
  const ambiguous = excluded.filter((area) => canonicalMunicipality(area) === 'toronto');
  if (ambiguous.length === 0) return { kind: 'outside' };

  if (place.lat === null || place.lng === null) {
    return {
      kind: 'unknown',
      field: 'coordinates',
      reason: `no coordinates: ${ambiguous.join(', ')} cannot be told apart from the rest of Toronto by name`,
    };
  }

  const { areas, error } = loadIndex();
  if (error !== null) {
    return { kind: 'unknown', field: 'excludeAreas', reason: `municipal boundaries unavailable — ${error}` };
  }

  const point = { lat: place.lat, lng: place.lng };
  for (const name of ambiguous) {
    const key = normalizeCity(name);
    const area = areas.find((a) => a.key === key);
    if (!area) {
      // A profile naming an area the boundary file does not have. Holding the listing is the
      // only honest answer: the cut it asked for was never evaluated.
      return {
        kind: 'unknown',
        field: 'excludeAreas',
        reason: `no boundary for "${name}"; known: ${areas.map((a) => a.name).join(', ')}`,
      };
    }
    if (pointInRing(point, area)) return { kind: 'inside', area: area.name, by: 'coordinates' };
  }

  return { kind: 'outside' };
}
