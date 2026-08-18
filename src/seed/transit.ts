import { fetchJson } from './http';
import { FUTURE_STATIONS, type SeedStation } from './future-stations';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/** Toronto and a margin, so extension stations just outside the border are still seen. */
const BBOX = '43.5,-79.85,43.95,-79.0';

/**
 * Two queries, because OSM models the two facts separately.
 *
 * 1. Station nodes carry the coordinates: railway=station with station=subway or
 *    station=light_rail. This is the tagging Line 5 and Line 6 actually use — checked, not
 *    assumed. Deliberately excluded: railway=tram_stop, which in Toronto means the 600-odd
 *    streetcar stops. Folding those in would put a "rapid transit stop" within 400 m of
 *    nearly every downtown listing and flatten the component to a constant.
 *
 * 2. Route relations carry the line membership, via their stop members.
 */
const STATIONS_QUERY = `[out:json][timeout:180];
(
  node["railway"="station"]["station"="subway"](${BBOX});
  node["railway"="station"]["station"="light_rail"](${BBOX});
);
out tags center;`;

const ROUTES_QUERY = `[out:json][timeout:180];
rel["type"="route"]["route"~"^(subway|light_rail)$"]["network"~"TTC|Toronto",i](${BBOX});
out body;
node(r);
out tags;`;

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * The lines that must be present. Line 5 and Line 6 are the point of this profile — a new
 * corridor whose inventory has not fully re-priced — so a seed that silently loses them is
 * worse than no seed at all.
 */
const REQUIRED_LINES: { ref: string; minStations: number }[] = [
  { ref: '1', minStations: 30 },
  { ref: '2', minStations: 25 },
  { ref: '5', minStations: 20 },
  { ref: '6', minStations: 15 },
];

function matchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+station$/, '')
    .replace(/[^a-z0-9]/g, '');
}

export async function fetchOperationalStations(contactEmail?: string): Promise<SeedStation[]> {
  const [stationsRes, routesRes] = await Promise.all([
    fetchJson<OverpassResponse>(OVERPASS_URL, {
      method: 'POST',
      body: STATIONS_QUERY,
      contactEmail,
      headers: { 'content-type': 'text/plain' },
    }),
    fetchJson<OverpassResponse>(OVERPASS_URL, {
      method: 'POST',
      body: ROUTES_QUERY,
      contactEmail,
      headers: { 'content-type': 'text/plain' },
    }),
  ]);

  // name -> line labels, from the route relations
  const lineByName = new Map<string, Set<string>>();
  const memberNodes = new Map<number, OverpassElement>();
  for (const el of routesRes.elements) {
    if (el.type === 'node') memberNodes.set(el.id, el);
  }
  for (const rel of routesRes.elements) {
    if (rel.type !== 'relation') continue;
    const ref = rel.tags?.ref;
    if (!ref) continue;
    const label = lineLabel(ref, rel.tags?.name);
    for (const member of rel.members ?? []) {
      if (member.type !== 'node') continue;
      const node = memberNodes.get(member.ref);
      const name = node?.tags?.name;
      if (!name) continue;
      const key = matchKey(name);
      if (!lineByName.has(key)) lineByName.set(key, new Set());
      lineByName.get(key)!.add(label);
    }
  }

  const stations: SeedStation[] = [];
  for (const el of stationsRes.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = el.tags?.name;
    if (lat === undefined || lng === undefined || !name) continue;

    const lines = lineByName.get(matchKey(name));
    const mode = el.tags?.station === 'light_rail' ? 'light_rail' : 'subway';

    stations.push({
      id: `osm:${el.id}`,
      name,
      // An interchange belongs to more than one line; keep them all in the label.
      line: lines ? [...lines].sort().join(' / ') : 'unknown',
      status: 'operational',
      mode,
      expectedYear: null,
      lat,
      lng,
      source: 'overpass',
    });
  }

  assertLinesPresent(stations);
  return stations;
}

function lineLabel(ref: string, name?: string): string {
  const known: Record<string, string> = {
    '1': 'Line 1 Yonge-University',
    '2': 'Line 2 Bloor-Danforth',
    '4': 'Line 4 Sheppard',
    '5': 'Line 5 Eglinton',
    '6': 'Line 6 Finch West',
  };
  return known[ref] ?? name ?? `Line ${ref}`;
}

/**
 * Fails the seed loudly rather than letting a thinned-out result through. Zero results and
 * "nothing changed today" look identical from the outside, and that is how a monitor dies
 * without anyone noticing.
 */
function assertLinesPresent(stations: SeedStation[]): void {
  const problems: string[] = [];
  for (const { ref, minStations } of REQUIRED_LINES) {
    const label = lineLabel(ref);
    const count = stations.filter((s) => s.line.includes(label)).length;
    if (count < minStations) {
      problems.push(`${label}: found ${count}, expected at least ${minStations}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Transit seed looks wrong, refusing to write it:\n  ${problems.join('\n  ')}\n` +
        `Check the Overpass tagging before continuing — Line 5 and Line 6 are the whole point of this profile.`,
    );
  }
}

export async function buildTransitSeed(contactEmail?: string): Promise<SeedStation[]> {
  const operational = await fetchOperationalStations(contactEmail);
  return [...operational, ...FUTURE_STATIONS];
}
