import { fetchJson, fetchText } from './http';
import { parseCsvRecords } from './csv';
import type { DaycareRow } from '@/db/schema';

const CKAN_BASE = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const DATASET_QUERY = 'licensed child care centres';
/** Expected slug. Used to pick the right hit, never as a hardcoded id. */
const DATASET_SLUG = 'licensed-child-care-centres';
/** EPSG:4326 = WGS84 lat/lng, which is what the distance maths needs. */
const RESOURCE_NAME_HINT = '4326.csv';

/** The dataset held ~1,090 centres when this was built; a large drop means something broke. */
const MIN_EXPECTED_CENTRES = 900;

interface CkanResource {
  id: string;
  name: string;
  format: string;
  url: string;
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

export type SeedDaycare = Omit<DaycareRow, 'updatedAt'>;

/**
 * Resolves the dataset through package_search rather than trusting a copied UUID.
 * Open-data portals re-publish resources; a hardcoded id fails silently one day and the
 * monitor quietly starts scoring every listing as having no childcare nearby.
 */
async function resolveCsvUrl(contactEmail?: string): Promise<{ url: string; packageId: string }> {
  const search = await fetchJson<CkanResponse<{ results: CkanPackage[] }>>(
    `${CKAN_BASE}/package_search?q=${encodeURIComponent(DATASET_QUERY)}`,
    { contactEmail },
  );
  if (!search.success) throw new Error('CKAN package_search failed');

  const pkg =
    search.result.results.find((p) => p.name === DATASET_SLUG) ??
    search.result.results.find((p) => p.title.toLowerCase().includes('licensed child care centres'));
  if (!pkg) {
    throw new Error(
      `Could not find the "${DATASET_QUERY}" dataset. Got: ${search.result.results.map((p) => p.name).join(', ')}`,
    );
  }

  const detail = await fetchJson<CkanResponse<CkanPackage>>(
    `${CKAN_BASE}/package_show?id=${encodeURIComponent(pkg.name)}`,
    { contactEmail },
  );
  const resource = detail.result.resources.find(
    (r) => r.format.toUpperCase() === 'CSV' && r.name.includes(RESOURCE_NAME_HINT),
  );
  if (!resource) {
    throw new Error(
      `No ${RESOURCE_NAME_HINT} resource in package ${pkg.name}. Available: ${detail.result.resources
        .map((r) => r.name)
        .join(', ')}`,
    );
  }

  return { url: resource.url, packageId: pkg.id };
}

function parseGeometry(raw: string): { lat: number; lng: number } | null {
  if (!raw) return null;
  try {
    const geom = JSON.parse(raw) as { coordinates?: unknown; type?: string };
    // The export uses MultiPoint: coordinates is [[lng, lat]], and GeoJSON is lng-first.
    const first = Array.isArray(geom.coordinates) ? (geom.coordinates[0] as unknown) : null;
    const pair = Array.isArray(first) ? (first as unknown[]) : null;
    if (!pair || pair.length < 2) return null;
    const lng = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

const int = (v: string | undefined): number => {
  const n = Number.parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
};
const yes = (v: string | undefined): boolean => (v ?? '').trim().toUpperCase() === 'Y';

export async function fetchDaycares(contactEmail?: string): Promise<SeedDaycare[]> {
  const { url } = await resolveCsvUrl(contactEmail);
  // CKAN serves this as a multi-megabyte CSV.
  const csv = await fetchText(url, { contactEmail, timeoutMs: 120_000 });
  const records = parseCsvRecords(csv);

  const out: SeedDaycare[] = [];
  let withoutCoordinates = 0;

  for (const r of records) {
    const point = parseGeometry(r.geometry ?? '');
    if (!point) {
      withoutCoordinates += 1;
      continue;
    }

    out.push({
      id: (r.LOC_ID ?? '').trim(),
      name: (r.LOC_NAME ?? '').trim(),
      auspice: (r.AUSPICE ?? '').trim() || null,
      address: (r.ADDRESS ?? '').trim() || null,
      postalCode: (r.PCODE ?? '').trim() || null,
      ward: (r.ward ?? '').trim() || null,
      phone: (r.PHONE ?? '').trim() || null,
      buildingType: (r.bldg_type ?? '').trim() || null,
      buildingName: (r.BLDGNAME ?? '').trim() || null,
      infantSpace: int(r.IGSPACE),
      toddlerSpace: int(r.TGSPACE),
      preschoolSpace: int(r.PGSPACE),
      kindergartenSpace: int(r.KGSPACE),
      schoolageSpace: int(r.SGSPACE),
      totalSpace: int(r.TOTSPACE),
      subsidy: yes(r.subsidy),
      cwelcc: yes(r.cwelcc_flag),
      lat: point.lat,
      lng: point.lng,
      sourceRunDate: (r.run_date ?? '').trim() || null,
    });
  }

  if (out.length < MIN_EXPECTED_CENTRES) {
    throw new Error(
      `Only ${out.length} child care centres parsed (expected at least ${MIN_EXPECTED_CENTRES}); ` +
        `${withoutCoordinates} rows had no usable geometry. Refusing to seed a truncated dataset.`,
    );
  }

  return out;
}
