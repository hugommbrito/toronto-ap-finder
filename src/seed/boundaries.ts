import { fetchJson } from './http';

const CKAN_BASE = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
/** Expected slug. Used to pick the right hit, never as a hardcoded resource id. */
const DATASET_SLUG = 'former-municipality-boundaries';
/** EPSG:4326 = WGS84 lng/lat, which is what the point-in-polygon maths expects. */
const RESOURCE_NAME_HINT = '4326.geojson';

/**
 * Vertices closer than this to the line they sit on are dropped.
 *
 * 25 m is far below anything that can change an answer here: these boundaries run down the
 * middle of arterial roads and rivers, so a listing is never 25 m from the line by accident
 * — and the full geometry is 12,000 vertices of surveyor detail for six shapes, which is
 * not something to commit or to walk per listing.
 */
const SIMPLIFY_TOLERANCE_M = 25;

/**
 * The six municipalities that were merged into the present City of Toronto in 1998, keyed
 * by the name the dataset uses.
 *
 * Doubles as the completeness check: a re-download that loses Scarborough would otherwise
 * turn a hard cut into a silent pass. `TORONTO` becomes `Old Toronto` because in a profile
 * that lists cities as `['Toronto']`, an area named "Toronto" would read as the whole city
 * rather than as the pre-amalgamation one — the same distinction geo/city.ts already makes.
 */
const AREA_NAMES: Record<string, string> = {
  SCARBOROUGH: 'Scarborough',
  'NORTH YORK': 'North York',
  'EAST YORK': 'East York',
  ETOBICOKE: 'Etobicoke',
  YORK: 'York',
  TORONTO: 'Old Toronto',
};

/** A [lng, lat] pair, in GeoJSON order. */
export type Vertex = [number, number];

export interface SeedBoundary {
  /** Display name, as a profile's `hard.excludeAreas` spells it. */
  name: string;
  /** Closed outer ring, [lng, lat]. None of the six has a hole or a second part. */
  ring: Vertex[];
}

interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
}

interface CkanResponse<T> {
  success: boolean;
  result: T;
}

interface GeoJsonFeature {
  properties?: Record<string, unknown>;
  geometry?: { type?: string; coordinates?: unknown };
}

interface GeoJsonCollection {
  features?: GeoJsonFeature[];
}

/**
 * Captures the former municipality boundaries as committed seed data.
 *
 * These are historical: the amalgamation happened in 1998 and the lines have not moved
 * since, which is why the result is read straight from data/seed/ by geo/areas.ts instead
 * of going through the database like daycares and stations. Refreshing it is a way to
 * check the upstream dataset, not a maintenance requirement.
 */
export async function fetchMunicipalBoundaries(contactEmail?: string): Promise<SeedBoundary[]> {
  const pkg = await fetchJson<CkanResponse<{ resources: CkanResource[] }>>(
    `${CKAN_BASE}/package_show?id=${encodeURIComponent(DATASET_SLUG)}`,
    { contactEmail },
  );
  if (!pkg.success) {
    throw new Error(`CKAN package_show failed for "${DATASET_SLUG}"`);
  }

  const resource = pkg.result.resources.find((r) => r.name.endsWith(RESOURCE_NAME_HINT));
  if (!resource) {
    throw new Error(
      `no "${RESOURCE_NAME_HINT}" resource in "${DATASET_SLUG}"; found: ${pkg.result.resources
        .map((r) => r.name)
        .join(', ')}`,
    );
  }

  const collection = await fetchJson<GeoJsonCollection>(resource.url, { contactEmail });
  return buildBoundarySeed(collection);
}

/** Split out from the download so the shape of the upstream file can be tested offline. */
export function buildBoundarySeed(collection: GeoJsonCollection): SeedBoundary[] {
  const boundaries: SeedBoundary[] = [];

  for (const feature of collection.features ?? []) {
    const areaName = String(feature.properties?.AREA_NAME ?? '').trim().toUpperCase();
    const name = AREA_NAMES[areaName];
    if (!name) continue;

    const ring = outerRing(feature.geometry);
    if (ring.length < 4) {
      throw new Error(`${name}: outer ring has only ${ring.length} vertices`);
    }
    boundaries.push({ name, ring: closeRing(simplify(ring, SIMPLIFY_TOLERANCE_M)) });
  }

  const missing = Object.values(AREA_NAMES).filter((n) => !boundaries.some((b) => b.name === n));
  if (missing.length > 0) {
    throw new Error(`boundary dataset is missing ${missing.join(', ')} — refusing to write a partial seed`);
  }

  return boundaries;
}

/**
 * The largest ring of the feature, whatever it is wrapped in.
 *
 * All six arrive as a single-part MultiPolygon today. Taking the largest ring rather than
 * the first means a future re-publication that splits one shape into an island plus a
 * mainland degrades to "the mainland" instead of to whichever part came first.
 */
function outerRing(geometry: GeoJsonFeature['geometry']): Vertex[] {
  const rings: Vertex[][] = [];

  const collect = (node: unknown, depth: number): void => {
    if (!Array.isArray(node)) return;
    if (depth === 0) {
      const ring = node.filter(
        (v): v is Vertex => Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number',
      );
      if (ring.length > 0) rings.push(ring);
      return;
    }
    for (const child of node) collect(child, depth - 1);
  };

  const type = geometry?.type;
  const depth = type === 'MultiPolygon' ? 2 : type === 'Polygon' ? 1 : -1;
  if (depth < 0) throw new Error(`unsupported geometry type "${String(type)}"`);
  collect(geometry?.coordinates, depth);

  return rings.sort((a, b) => b.length - a.length)[0] ?? [];
}

function closeRing(ring: Vertex[]): Vertex[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

/** Metres per degree of latitude, and of longitude at Toronto's latitude. */
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((43.7 * Math.PI) / 180);

/** Perpendicular distance from `p` to the segment `a`-`b`, in metres. */
function perpendicularMeters(p: Vertex, a: Vertex, b: Vertex): number {
  const px = (p[0] - a[0]) * M_PER_DEG_LNG;
  const py = (p[1] - a[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * M_PER_DEG_LNG;
  const by = (b[1] - a[1]) * M_PER_DEG_LAT;

  const lengthSq = bx * bx + by * by;
  if (lengthSq === 0) return Math.hypot(px, py);

  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Ramer-Douglas-Peucker, iterative so a 3,600-vertex ring cannot blow the stack. */
function simplify(ring: Vertex[], toleranceM: number): Vertex[] {
  if (ring.length < 3) return ring;

  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = true;
  keep[ring.length - 1] = true;

  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let worstDistance = 0;

    for (let i = start + 1; i < end; i += 1) {
      const distance = perpendicularMeters(ring[i]!, ring[start]!, ring[end]!);
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }

    if (worst !== -1 && worstDistance > toleranceM) {
      keep[worst] = true;
      stack.push([start, worst], [worst, end]);
    }
  }

  return ring.filter((_, i) => keep[i]);
}

/**
 * One line per ring.
 *
 * The default `JSON.stringify(x, null, 2)` used for the other seed files puts every
 * coordinate on its own line, which would make this a 12,000-line file where the useful
 * unit of change — "Scarborough's outline moved" — is invisible. Compact rings keep the
 * diff to one line per area.
 */
export function serializeBoundaries(boundaries: SeedBoundary[]): string {
  const entries = boundaries.map(
    (b) => `  {\n    "name": ${JSON.stringify(b.name)},\n    "ring": ${JSON.stringify(b.ring)}\n  }`,
  );
  return `[\n${entries.join(',\n')}\n]\n`;
}
