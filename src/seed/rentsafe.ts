import { fetchJson, fetchText } from './http';
import { parseCsvRecords } from './csv';
import { normalizeAddress } from '@/geo/address';
import type { RentSafeBuildingRow } from '@/db/schema';

const CKAN_BASE = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const DATASET_QUERY = 'apartment building evaluation';
/** Expected slug. Used to pick the right hit, never as a hardcoded id. */
const DATASET_SLUG = 'apartment-building-evaluation';
/**
 * The package carries a "Pre-2023" resource alongside the current one, and **both are
 * datastore_active**. Selecting on format and activity alone would pick whichever came first and
 * seed a snapshot years out of date, with nothing about it looking wrong.
 */
const RESOURCE_NAME_PATTERN = /2023\s*-\s*current$/i;

/** 3,585 buildings when this was built. A large drop means the upstream shape changed. */
const MIN_EXPECTED_BUILDINGS = 3_000;

/** Ontario's rent control cut-off is 15 November 2018, and this data carries only a year. */
const RENT_CONTROL_LAST_FULL_YEAR = 2017;
const RENT_CONTROL_FIRST_CLEAR_YEAR = 2019;

interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
  datastore_active: boolean;
}

interface CkanPackage {
  id: string;
  name: string;
  title: string;
  resources: CkanResource[];
}

interface CkanResponse<T> {
  success: boolean;
  result: T;
}

export type SeedRentSafeBuilding = Omit<RentSafeBuildingRow, 'updatedAt'>;

/**
 * Resolves the dataset through package_search rather than trusting a copied UUID, for the reason
 * the daycare seed gives: a hardcoded id fails silently one day, and a silent failure here means
 * every building quietly scores as unrated.
 */
async function resolveCsvUrl(contactEmail?: string): Promise<string> {
  const search = await fetchJson<CkanResponse<{ results: CkanPackage[] }>>(
    `${CKAN_BASE}/package_search?q=${encodeURIComponent(DATASET_QUERY)}`,
    { contactEmail },
  );
  if (!search.success) throw new Error('CKAN package_search failed');

  const pkg = search.result.results.find((p) => p.name === DATASET_SLUG);
  if (!pkg) {
    throw new Error(
      `Could not find the "${DATASET_SLUG}" dataset. Got: ${search.result.results.map((p) => p.name).join(', ')}`,
    );
  }

  const detail = await fetchJson<CkanResponse<CkanPackage>>(
    `${CKAN_BASE}/package_show?id=${encodeURIComponent(pkg.name)}`,
    { contactEmail },
  );
  const resource = detail.result.resources.find(
    (r) => r.datastore_active && RESOURCE_NAME_PATTERN.test(r.name),
  );
  if (!resource) {
    throw new Error(
      `No current evaluations resource in ${pkg.name}. Available: ${detail.result.resources
        .map((r) => `${r.name} (active=${r.datastore_active})`)
        .join(', ')}`,
    );
  }
  // The dump endpoint serves the whole table as CSV; datastore_search_sql answers 404 on this
  // portal, so there is no server-side way to deduplicate.
  return `https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/${resource.id}`;
}

function int(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function float(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** `2026-05-14T00:00:00` → `2026-05-14`, and anything unparseable → null. */
function isoDate(raw: string | undefined): string | null {
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0]! : null;
}

/**
 * Whether the building predates Ontario's rent control cut-off.
 *
 * 2018 is left **undecided** rather than guessed: the statutory line is 15 November 2018 and this
 * column carries only a year, so a 2018 building could fall on either side. Fourteen buildings are
 * affected. Guessing would put a fact into a field the rest of the project treats as evidence.
 */
export function builtBeforeRentControl(yearBuilt: number | null): boolean | null {
  if (yearBuilt === null) return null;
  if (yearBuilt <= RENT_CONTROL_LAST_FULL_YEAR) return true;
  if (yearBuilt >= RENT_CONTROL_FIRST_CLEAR_YEAR) return false;
  return null;
}

/**
 * One row per building, from a file with one row per evaluation.
 *
 * 6,090 rows describe 3,585 buildings; 2,504 of them have been evaluated more than once, and one
 * has three. Keeping every row would make "this building's score" a question with several
 * answers, so the most recent evaluation wins.
 *
 * Exported and pure so the parsing is tested without a network — the fixture under
 * test/fixtures/rentsafe/ carries the awkward rows on purpose.
 */
export function parseEvaluations(csv: string): SeedRentSafeBuilding[] {
  const rows = parseCsvRecords(csv);
  const latest = new Map<string, { row: Record<string, string>; on: string }>();

  for (const row of rows) {
    const rsn = row.RSN?.trim();
    const score = int(row['CURRENT BUILDING EVAL SCORE']);
    const address = row['SITE ADDRESS']?.trim();
    // A building with no score is not a building this can say anything about.
    if (!rsn || !address || score === null) continue;

    const on = isoDate(row['EVALUATION COMPLETED ON']) ?? '';
    const held = latest.get(rsn);
    // Ties keep the first seen, which the file orders by evaluation, so this is stable.
    if (!held || on > held.on) latest.set(rsn, { row, on });
  }

  return [...latest.entries()].map(([rsn, { row, on }]) => ({
    rsn,
    siteAddress: row['SITE ADDRESS']!.trim(),
    normalizedAddress: normalizeAddress(row['SITE ADDRESS']),
    score: int(row['CURRENT BUILDING EVAL SCORE'])!,
    evaluatedOn: on || null,
    yearBuilt: int(row['YEAR BUILT']),
    confirmedStoreys: int(row['CONFIRMED STOREYS']),
    confirmedUnits: int(row['CONFIRMED UNITS']),
    propertyType: row['PROPERTY TYPE']?.trim() || null,
    ward: row.WARD?.trim() || null,
    wardName: row.WARDNAME?.trim() || null,
    lat: float(row.LATITUDE),
    lng: float(row.LONGITUDE),
  }));
}

export async function fetchRentSafeBuildings(contactEmail?: string): Promise<SeedRentSafeBuilding[]> {
  const url = await resolveCsvUrl(contactEmail);
  // 1.6 MB, well past what the 30 s default is sized for.
  const csv = await fetchText(url, { contactEmail, timeoutMs: 120_000 });
  const buildings = parseEvaluations(csv);

  if (buildings.length < MIN_EXPECTED_BUILDINGS) {
    throw new Error(
      `Only ${buildings.length} RentSafeTO buildings parsed (expected at least ` +
        `${MIN_EXPECTED_BUILDINGS}); refusing to seed a truncated dataset.`,
    );
  }
  return buildings;
}
