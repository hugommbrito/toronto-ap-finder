import { fetchJson } from './http';
import type { SeedDaycare } from './daycares';

/**
 * Licensed child care outside the City of Toronto, from the regions' own ArcGIS portals.
 *
 * **What these datasets do not have, and why it shapes everything downstream:** neither Peel
 * nor Waterloo publishes licensed capacity per age group. Toronto's IGSPACE/TGSPACE/... columns
 * have no counterpart here, so there is no way to ask "does this centre have toddler places?".
 * Rows are therefore seeded with `capacityKnown: false` and every capacity column at 0, and
 * `geo/coverage.ts` is what stops that being read as a centre licensed for nobody.
 *
 * Alternatives that were checked and rejected:
 *
 * - **Ontario's provincial dataset** (`data.ontario.ca`, *Licensed child care facilities in
 *   Ontario*) covers every municipality, but it is XLSX only, carries no coordinates, no
 *   capacity by age group and no CWELCC flag. Without coordinates it would need a geocoder,
 *   and there is none in this project — `geocodeCache` is declared and unused.
 * - **County of Simcoe** (which is why Wasaga Beach is not here) publishes no child care
 *   dataset at all.
 *
 * Both endpoints return WGS84 (`outSR=4326`), which is what the distance maths needs, so no
 * reprojection is involved.
 */

/** ArcGIS pages at 1,000-2,000 features regardless of what is asked for. */
const PAGE_SIZE = 1000;

interface ArcGisFeature {
  attributes: Record<string, string | number | null>;
  geometry?: { x: number; y: number };
}

interface ArcGisResponse {
  features?: ArcGisFeature[];
  exceededTransferLimit?: boolean;
  error?: { message?: string };
}

/**
 * Pages an ArcGIS FeatureServer layer with `resultOffset`.
 *
 * Written as its own loop because `seed/http.ts` is transport-only and has no pagination
 * helper — deliberately, since every portal spells paging differently.
 */
async function fetchLayer(
  baseUrl: string,
  outFields: string[],
  contactEmail?: string,
): Promise<ArcGisFeature[]> {
  const out: ArcGisFeature[] = [];

  /**
   * Advanced by rows received, not by the page size asked for.
   *
   * A layer whose own `maxRecordCount` is below PAGE_SIZE returns fewer rows *and* sets
   * `exceededTransferLimit`, so stepping by PAGE_SIZE would skip everything between what arrived
   * and what was requested — silently, and `assertNotTruncated` would not notice a moderate loss.
   * Latent for Peel and Waterloo, which both fit in one page, and a trap for the next region.
   */
  for (let offset = 0; ; ) {
    const query =
      `${baseUrl}/query?where=1%3D1` +
      `&outFields=${encodeURIComponent(outFields.join(','))}` +
      `&returnGeometry=true&outSR=4326&f=json` +
      `&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}`;

    const page = await fetchJson<ArcGisResponse>(query, { contactEmail, timeoutMs: 120_000 });
    if (page.error) throw new Error(`ArcGIS refused ${baseUrl}: ${page.error.message ?? 'unknown error'}`);

    const features = page.features ?? [];
    out.push(...features);
    offset += features.length;

    // An empty page always ends it; otherwise the advisory flag decides, since some servers
    // omit it and simply return short.
    if (features.length === 0) break;
    if (features.length < PAGE_SIZE && !page.exceededTransferLimit) break;
    if (offset > 50_000) throw new Error(`${baseUrl}: paging did not terminate`);
  }

  return out;
}

function point(f: ArcGisFeature): { lat: number; lng: number } | null {
  const g = f.geometry;
  if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  // ArcGIS is x = longitude, y = latitude.
  return { lat: g.y, lng: g.x };
}

const str = (v: string | number | null | undefined): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/**
 * A row from a presence-only region.
 *
 * Capacity stays at 0 across the board and `capacityKnown` is false — the pair is the record
 * that nobody published it. `cwelcc` is likewise false-as-unstated, which is why
 * `daycareAffordability` abstains for these regions rather than scoring them badly.
 *
 * **The id carries the coordinates, because the upstream id is not unique.** Peel reuses
 * `LM_ID` across genuinely different locations — `FLORA01` is two addresses 2 km apart,
 * `MISSI01` two addresses 14 km apart — which is a defect in their data, not in ours. Keying
 * on `LM_ID` alone made four centres vanish into the primary key, and the seed upserts, so it
 * would have looked like success. Appending the point is deterministic and order-independent,
 * unlike a collision counter, and stable across republishes in a way ArcGIS `OBJECTID` is not
 * — that gets reassigned, and with no prune pass in the seed each republish would accumulate a
 * fresh copy of every row.
 */
function presenceOnlyRow(
  region: string,
  id: string,
  name: string,
  address: string | null,
  postalCode: string | null,
  phone: string | null,
  subsidy: boolean,
  at: { lat: number; lng: number },
): SeedDaycare {
  return {
    id: `${region}:${id}@${at.lat.toFixed(5)},${at.lng.toFixed(5)}`,
    name,
    region,
    capacityKnown: false,
    auspice: null,
    address,
    postalCode,
    ward: null,
    phone,
    buildingType: null,
    buildingName: null,
    infantSpace: 0,
    toddlerSpace: 0,
    preschoolSpace: 0,
    kindergartenSpace: 0,
    schoolageSpace: 0,
    totalSpace: 0,
    subsidy,
    cwelcc: false,
    lat: at.lat,
    lng: at.lng,
    sourceRunDate: null,
  };
}

const PEEL_URL =
  'https://services6.arcgis.com/ONZht79c8QWuX759/arcgis/rest/services/Child_Care_Centres/FeatureServer/0';
/** Held 581 centres when this was written; a large drop means the layer changed under us. */
const PEEL_MIN_EXPECTED = 450;

/**
 * Region of Peel — covers Mississauga, Brampton and Caledon.
 *
 * `Type` is the one useful extra: it reads `Community-Based Centre (Subsidy Available)` and
 * similar, so municipal fee subsidy *is* knowable here. That is not CWELCC and is not treated
 * as it — CWELCC is worth CAD 800-1200/month and subsidy is a weaker, means-tested signal.
 */
export async function fetchPeelDaycares(contactEmail?: string): Promise<SeedDaycare[]> {
  const features = await fetchLayer(
    PEEL_URL,
    ['LM_ID', 'LM_NAME', 'STR_ADDR', 'POSTAL', 'PHONE', 'MUN', 'Type'],
    contactEmail,
  );

  const out: SeedDaycare[] = [];
  for (const f of features) {
    const at = point(f);
    const id = str(f.attributes.LM_ID);
    const name = str(f.attributes.LM_NAME);
    if (!at || !id || !name) continue;

    out.push(
      presenceOnlyRow(
        'peel',
        id,
        name,
        str(f.attributes.STR_ADDR),
        str(f.attributes.POSTAL),
        str(f.attributes.PHONE),
        (str(f.attributes.Type) ?? '').includes('Subsidy Available'),
        at,
      ),
    );
  }

  assertNotTruncated('Peel', out.length, PEEL_MIN_EXPECTED, features.length);
  return out;
}

const WATERLOO_URL =
  'https://utility.arcgis.com/usrsvcs/servers/fad117ba47bb47b68a916f95fac7cd2f/rest/services/OpenData/OpenData/MapServer/22';
/** Held 287 centres when this was written. */
const WATERLOO_MIN_EXPECTED = 220;

/**
 * Region of Waterloo — covers Cambridge, Kitchener, Waterloo and the four townships.
 *
 * Thinner than Peel: `Category` is uniformly `'Day Nurseries'`, so it carries no information,
 * and there is no subsidy field at all. Name, street and a point is the whole of it.
 */
export async function fetchWaterlooDaycares(contactEmail?: string): Promise<SeedDaycare[]> {
  const features = await fetchLayer(
    WATERLOO_URL,
    ['FacilityMasterID', 'FacilityName', 'SiteStreet', 'SiteCity', 'SiteTelephone'],
    contactEmail,
  );

  const out: SeedDaycare[] = [];
  for (const f of features) {
    const at = point(f);
    const id = str(f.attributes.FacilityMasterID);
    const name = str(f.attributes.FacilityName);
    if (!at || !id || !name) continue;

    out.push(
      presenceOnlyRow(
        'waterloo',
        id,
        name,
        str(f.attributes.SiteStreet),
        null,
        str(f.attributes.SiteTelephone),
        false,
        at,
      ),
    );
  }

  assertNotTruncated('Waterloo', out.length, WATERLOO_MIN_EXPECTED, features.length);
  return out;
}

/**
 * Per-region, because one global threshold would be wrong for all of them.
 *
 * Same reasoning as the Toronto seeder's MIN_EXPECTED_CENTRES: a quietly truncated dataset
 * makes the monitor score listings as having no childcare nearby, which looks like a verdict.
 */
function assertNotTruncated(region: string, kept: number, minimum: number, fetched: number): void {
  if (kept < minimum) {
    throw new Error(
      `Only ${kept} ${region} child care centres usable of ${fetched} fetched ` +
        `(expected at least ${minimum}). Refusing to seed a truncated dataset.`,
    );
  }
}
