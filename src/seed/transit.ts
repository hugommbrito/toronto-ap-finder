import { fetchJson } from './http';
import { FUTURE_STATIONS, type SeedStation } from './future-stations';
import { haversineMeters } from '@/geo/distance';

/** How far a route's platform node may sit from the station node and still be the same stop. */
const SAME_STATION_M = 1000;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
/**
 * Toronto, Peel and Waterloo, plus a margin so extension stations just past a border are seen.
 *
 * Widening this is the whole of what the 905 needed from transit, and the reason is worth
 * stating: once the box covers a region, a zero becomes a **true statement** about that
 * address rather than a hole in the data. Mississauga genuinely has no subway or LRT, and the
 * nearest ION stop to Cambridge is Fairway, some 13 km away — so those listings should score 0
 * on transit, and now they do so honestly. Before, they scored 0 because we had never looked.
 *
 * This is why transit needs no coverage concept while childcare does (see geo/coverage.ts):
 * OSM covers every region uniformly, so absence is observable. No child care dataset does.
 */
const BBOX = '43.2,-80.6,44.0,-79.0';

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

/**
 * The network filter has to name every agency the box now covers.
 *
 * It read `TTC|Toronto`, which was exactly right while the box was Toronto. Widening the box to
 * Peel and Waterloo without widening this brought in seventeen ION platforms whose route
 * relations were never fetched, so they landed with `line: 'unknown'` — and `reachableLines`
 * puts the line name straight into the notification, so a listing in Waterloo would have
 * announced "unknown". Stations arriving without a line is the failure this pairing prevents.
 */
const ROUTES_QUERY = `[out:json][timeout:180];
rel["type"="route"]["route"~"^(subway|light_rail)$"]["network"~"TTC|Toronto|Ion|Grand River Transit",i](${BBOX});
out body;
node(r);
out body;`;

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
/**
 * Deliberately still Toronto-only, even though the box now reaches Waterloo.
 *
 * This list is a guard against a silently truncated seed, and it is priced accordingly: the
 * lines that can actually move a score are the ones a profile might live next to, and with
 * `transitOperational` cut to 4 of 142 weight, transit can no longer decide anything on its
 * own. Adding an ION assertion would buy very little and would fail the seed for a region the
 * profile scores at 0 either way.
 *
 * The cost, stated so nobody discovers it the hard way: if ION disappeared from OSM the seed
 * would still pass. Acceptable at this weight, not acceptable if transit is ever restored.
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
    // The query carries its own [out:json][timeout:180]; the client has to outlast it.
    timeoutMs: 200_000,
      body: STATIONS_QUERY,
      contactEmail,
      headers: { 'content-type': 'text/plain' },
    }),
    fetchJson<OverpassResponse>(OVERPASS_URL, {
      method: 'POST',
    // The query carries its own [out:json][timeout:180]; the client has to outlast it.
    timeoutMs: 200_000,
      body: ROUTES_QUERY,
      contactEmail,
      headers: { 'content-type': 'text/plain' },
    }),
  ]);

  /**
   * name -> line labels, from the route relations, **with the stop's position kept**.
   *
   * The position is what stops a homonym merging two networks. Route relations list platform
   * nodes rather than the station node, so they are matched to stations by name — fine while
   * every station was TTC, and wrong the moment the box reached Waterloo: ION has a "Queen" and
   * a "Victoria Park", and so do Line 1 and Line 2. Keyed on name alone, all four stations came
   * out labelled with both networks, and `reachableLines` puts that label straight into a
   * notification — so a listing above Queen station would have advertised an LRT in Kitchener.
   */
  const lineByName = new Map<string, { label: string; lat: number; lng: number }[]>();
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
      const lat = node?.lat ?? node?.center?.lat;
      const lng = node?.lon ?? node?.center?.lon;
      if (!name || lat === undefined || lng === undefined) continue;
      const key = matchKey(name);
      if (!lineByName.has(key)) lineByName.set(key, []);
      lineByName.get(key)!.push({ label, lat, lng });
    }
  }

  const stations: SeedStation[] = [];
  for (const el of stationsRes.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = el.tags?.name;
    if (lat === undefined || lng === undefined || !name) continue;

    // Same name *and* the same place. Platforms of one complex sit within a few hundred metres
    // of its station node, so this keeps every genuine interchange while refusing a homonym
    // 100 km away.
    const candidates = lineByName.get(matchKey(name)) ?? [];
    const lines = new Set(
      candidates
        .filter((c) => haversineMeters({ lat, lng }, { lat: c.lat, lng: c.lng }) <= SAME_STATION_M)
        .map((c) => c.label),
    );
    const mode = el.tags?.station === 'light_rail' ? 'light_rail' : 'subway';

    stations.push({
      id: `osm:${el.id}`,
      name,
      // An interchange belongs to more than one line; keep them all in the label.
      line: lines.size > 0 ? [...lines].sort().join(' / ') : 'unknown',
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
    // Region of Waterloo. Reaches Kitchener and Waterloo but not Cambridge — ION Stage 2 is
    // unbuilt, so the nearest stop to a Cambridge address is Fairway, some 13 km away.
    '301': 'ION Line 301',
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
