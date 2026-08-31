import type { TriageListing } from '@/listings/listing.types';
import { toSearchableText } from '@/extraction/normalize';
import type { BuildingEntry, BuildingPage, SearchTarget, UnparsableListing } from '../source.interface';

export class ZumperParseError extends Error {
  constructor(message: string) {
    super(`zumper: ${message}`);
    this.name = 'ZumperParseError';
  }
}

const BASE = 'https://www.zumper.com';

/**
 * Pulls a JSON array out of the page's inline application state.
 *
 * Zumper has no `__NEXT_DATA__` block. Both pages carry one large inline `<script>` in which
 * the state is written as a JavaScript literal, so the array is located by key and then
 * decoded by balancing brackets — the surrounding script is not JSON and cannot be parsed
 * whole. String literals are tracked while balancing, otherwise a bracket inside an
 * advertisement body ends the array early.
 *
 * `isWanted` is not optional decoration. The search page holds **sixteen** keys named
 * `listables`, and the first several belong to unrelated state slices — the affordability
 * calculator, the agent profile — which are empty arrays. Taking the first key that parses
 * returns `[]` and looks exactly like a city with no rentals in it, so the caller has to say
 * what a real element looks like.
 */
export function extractStateArray(html: string, key: string, isWanted: (item: unknown) => boolean): unknown[] {
  const marker = `"${key}":`;
  let from = 0;
  for (;;) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    const start = html.indexOf('[', at + marker.length);
    if (start === -1 || html.slice(at + marker.length, start).trim() !== '') {
      from = at + marker.length;
      continue;
    }
    const end = matchingBracket(html, start);
    if (end !== -1) {
      try {
        const parsed: unknown = JSON.parse(html.slice(start, end + 1));
        if (Array.isArray(parsed) && parsed.length > 0 && isWanted(parsed[0])) return parsed;
      } catch {
        // Not the block we want; keep looking rather than failing on the first candidate.
      }
    }
    from = at + marker.length;
  }
  throw new ZumperParseError(`no usable "${key}" array in page state`);
}

/** A building carries an id and its own coordinates; the decoy slices carry neither. */
function isBuilding(item: unknown): boolean {
  const o = item as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && 'listing_id' in o && ('lat' in o || 'building_id' in o);
}

/** A floorplan carries a layout; that is what distinguishes it from every other array. */
function isUnit(item: unknown): boolean {
  const o = item as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && 'listing_id' in o && ('bedrooms' in o || 'price' in o);
}

function matchingBracket(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Search pages list buildings. Nothing here is scoreable — see docs/sources/zumper.md. */
export function parseSearchPage(html: string): BuildingPage {
  const raw = extractStateArray(html, 'listables', isBuilding) as Record<string, unknown>[];

  const buildings: BuildingEntry[] = [];
  const unparsable: UnparsableListing[] = [];

  for (const item of raw) {
    const sourceId = str(item.listing_id);
    const path = typeof item.url === 'string' ? item.url : null;
    if (!sourceId || !path) {
      unparsable.push({ sourceId: sourceId ?? '(unknown)', url: path, reason: 'missing id or url' });
      continue;
    }
    // A building with no coordinates cannot be measured against daycares or transit, and
    // geocoding it is out of scope. Logged rather than dropped, so it can be counted.
    if (num(item.lat) === null || num(item.lng) === null) {
      unparsable.push({ sourceId, url: absolute(path), reason: 'building has no coordinates' });
      continue;
    }

    buildings.push({
      sourceId,
      url: absolute(path),
      name: typeof item.building_name === 'string' ? item.building_name : '',
      address: typeof item.address === 'string' ? item.address : null,
      city: typeof item.city === 'string' ? item.city : null,
      lat: num(item.lat),
      lng: num(item.lng),
      minPrice: num(item.min_price),
      maxPrice: num(item.max_price),
      minBedrooms: num(item.min_bedrooms),
      maxBedrooms: num(item.max_bedrooms),
      floorplanCount: num(item.floorplan_count) ?? 0,
      modifiedOn: epoch(item.modified_on),
      amenityTags: strings(item.building_amenity_tags),
    });
  }

  return { buildings, unparsable, pagination: parsePagination(html, raw.length) };
}

function parsePagination(html: string, pageSize: number): BuildingPage['pagination'] {
  const total = /"total":\s*\{\s*"count":\s*(\d+)/.exec(html);
  return { offset: 0, limit: pageSize, totalCount: total ? Number(total[1]) : 0 };
}

/**
 * Building pages carry every floorplan the building offers, each with its own price and
 * layout. One request therefore yields many listings — the opposite of Kijiji, where one
 * request yields one.
 *
 * There is no second stage, because there is nothing more to fetch: Zumper publishes **no
 * advertisement prose at all**. Measured on a real building — `description` and
 * `short_description` were empty for all 38 floorplans, and the building's own description is
 * 192 characters of SEO boilerplate ("View detailed information about..."). Both fields are
 * still read, so the day Zumper starts filling them we get them for free; today they are
 * empty and `rawText` stays null, which is the honest record.
 */
export function parseBuildingPage(html: string, building: BuildingEntry): TriageListing[] {
  const raw = extractStateArray(html, 'floorplan_listings', isUnit) as Record<string, unknown>[];
  const listings: TriageListing[] = [];

  for (const unit of raw) {
    const sourceId = str(unit.listing_id);
    const rentBase = num(unit.price);
    // "Call for pricing" floorplans cannot be scored against a rent target.
    if (!sourceId || rentBase === null || rentBase <= 0) continue;

    const description = [unit.description, unit.short_description]
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .join('\n\n');
    const amenities = [...strings(unit.amenity_tags), ...building.amenityTags];
    const text = toSearchableText(description);

    listings.push({
      source: 'zumper',
      sourceId,
      url: building.url,
      title: unitTitle(unit, building),
      rawText: text.length > 0 ? text : null,
      rentBase,
      // With no prose to read, the building's amenity list is the *only* statement about
      // parking, and it speaks for every unit in the building.
      parkingIncluded: hasAmenity(amenities, PARKING_TAGS) ? true : null,
      parkingCost: null,
      utilitiesIncluded: [],
      totalMonthlyCost: rentBase,
      beds: num(unit.bedrooms),
      // Zumper has no den field, and no text in which a den could be named. So a 2BR+den is
      // recorded as a plain 2BR and scores one tier lower than it deserves. That error is
      // deliberately one-directional: it undersells a unit, never oversells one — the
      // opposite of the 1BR+den-as-2BR problem that made the verifier necessary.
      dens: 0,
      baths: bathrooms(unit),
      hasLocker: hasAmenity(amenities, LOCKER_TAGS) ? true : null,
      inSuiteLaundry: hasAmenity(amenities, IN_SUITE_LAUNDRY_TAGS) ? true : null,
      address: building.address,
      city: building.city,
      // Floorplans have no coordinates of their own; they are in the building.
      lat: building.lat,
      lng: building.lng,
      availableFrom: typeof unit.date_available === 'string' ? unit.date_available : null,
      postedAt: epoch(unit.listed_on) ?? epoch(unit.created_on),
      buildingBuiltBefore2018: null,
    });
  }

  if (listings.length === 0 && raw.length > 0) {
    throw new ZumperParseError(`building ${building.sourceId} listed ${raw.length} floorplans, none priced`);
  }
  return listings;
}

const PARKING_TAGS = ['garage parking', 'underground parking', 'parking', 'covered parking'];
const LOCKER_TAGS = ['storage', 'storage locker', 'bicycle room'];
const IN_SUITE_LAUNDRY_TAGS = ['in-unit laundry', 'washer in-suite', 'in suite laundry'];

/** Amenity lists are free text; only an exact tag match counts as a fact. */
function hasAmenity(tags: string[], wanted: string[]): boolean {
  const lower = tags.map((t) => t.toLowerCase().trim());
  return wanted.some((w) => lower.includes(w));
}

function unitTitle(unit: Record<string, unknown>, building: BuildingEntry): string {
  const plan = typeof unit.name === 'string' && unit.name.length > 0 ? unit.name : null;
  const beds = num(unit.bedrooms);
  const layout = beds === null ? '' : beds === 0 ? 'Studio' : `${beds} Bed`;
  return [building.name || building.address || 'Zumper listing', plan, layout]
    .filter((p) => p !== null && p !== '')
    .join(' — ');
}

/** Half bathrooms are counted separately, as they are in the listing model. */
function bathrooms(unit: Record<string, unknown>): number | null {
  const full = num(unit.bathrooms);
  if (full === null) return null;
  const half = num(unit.half_bathrooms) ?? 0;
  return full + half * 0.5;
}

/**
 * Zumper's targets are plain city slugs, so unlike Kijiji these are genuinely municipal — a
 * `cambridge-on` search returns Cambridge and not the whole region.
 *
 * Path-only, because robots.txt disallows the `?loc=`, `?box=` and `?s=` query filters; only
 * `?page=` is permitted. All three slugs were confirmed to resolve.
 */
export const ZUMPER_TARGETS: readonly (SearchTarget & { citySlug: string })[] = [
  { key: 'toronto', label: 'Toronto', citySlug: 'toronto-on' },
  { key: 'peel', label: 'Mississauga', citySlug: 'mississauga-on' },
  { key: 'waterloo', label: 'Cambridge', citySlug: 'cambridge-on' },
];

export function buildSearchUrl(page: number, citySlug = 'toronto-on'): string {
  const path = `${BASE}/apartments-for-rent/${citySlug}`;
  // robots.txt disallows ?s=, ?loc=, ?box=, ?bedrooms= and ?bathrooms=. `page` is not among
  // them, and it is the only parameter we ever send.
  return page <= 1 ? path : `${path}?page=${page}`;
}

function absolute(path: string): string {
  return path.startsWith('http') ? path : `${BASE}${path}`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Zumper timestamps are seconds since the epoch, not milliseconds. */
function epoch(v: unknown): Date | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return new Date(n * 1000);
}
