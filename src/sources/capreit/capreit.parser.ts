import type { TriageListing } from '@/listings/listing.types';
import { toSearchableText } from '@/extraction/normalize';
import type { BuildingEntry } from '../source.interface';

/**
 * Pure parsing for CAPREIT. No network, no database — driven by the fixtures under
 * test/fixtures/capreit/, so the suite stays offline and deterministic.
 *
 * See docs/sources/pm_capreit.md for how the shape below was established, and for why the two
 * other property managers the addendum named are closed.
 */
export class CapreitParseError extends Error {
  constructor(message: string) {
    super(`capreit: ${message}`);
    this.name = 'CapreitParseError';
  }
}

const BASE = 'https://www.capreit.ca';

/** The five names that are one municipality, as the profile spells them. */
const GTA_CITY_SLUGS = ['toronto', 'north-york', 'etobicoke', 'scarborough', 'east-york'];

/**
 * Building-wide amenities that speak for every unit, and only when they are unqualified.
 *
 * CAPREIT marks conditional amenities with an asterisk — `Parking*`, `Storage*` — and never says
 * what the asterisk means. Reading those as `true` would turn a disclaimer into a promise, so
 * they are left unknown. This is the same discipline the rest of the project applies to a missing
 * field: an ambiguous statement is `null`, never `false` and never `true`.
 */
const PARKING_TAGS = ['parking', 'garage'];
const LOCKER_TAGS = ['storage', 'locker'];
/**
 * A bike room is not a locker.
 *
 * `Bicycle Storage` appears unasterisked alongside the asterisked `Storage*`, so a plain search
 * for "storage" awards locker credit to every building with somewhere to put a bicycle. The
 * component carries a weight of 5, so the error is small per listing and systematic across all of
 * them, which is the worse of the two ways to be wrong.
 */
const NOT_A_LOCKER = ['bicycle', 'bike'];
const IN_SUITE_LAUNDRY_TAGS = ['in-suite laundry', 'in suite laundry', 'ensuite laundry'];
const UTILITY_TAGS: Array<[string, string]> = [
  ['water included', 'water'],
  ['heat included', 'heat'],
  ['hydro included', 'hydro'],
  ['electricity included', 'hydro'],
  ['internet included', 'internet'],
];

interface JsonLdApartment {
  name?: string;
  url?: string;
  description?: string;
  address?: unknown;
  geo?: unknown;
  amenityFeature?: unknown;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** JSON-LD arrives with the page's indentation, and its entities, inside its string values. */
function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

const POSTAL = /\b[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d\b/;
const PROVINCE = /^(?:on|ont|ontario|qc|ab|bc|ns|nb|mb|sk|pe|nl)$/i;

/**
 * Street and city, read out of the whole address rather than out of the fields.
 *
 * The fields cannot be trusted individually. On a building with a compound address the template
 * spills the parts one key to the left — `7 & 9 Roanoke Road, North York, ON, M3A 1E3` arrives as
 * `streetAddress: '7'`, `addressLocality: '9 Roanoke Road'`, `addressRegion: 'North York'`,
 * `postalCode: 'ON, M3A 1E3'` — while a plain address arrives correctly aligned. Trusting
 * `addressLocality` therefore put a street into the city column for eleven of eighty-two units,
 * and every one of them was then rejected by the city filter: fetched, parsed, and thrown away
 * for a reason that was ours rather than theirs.
 *
 * So the parts are joined and read as one string, which is what the rest of the project already
 * assumes an address is — `normalizeAddress` exists precisely because sources disagree about
 * where the city goes.
 */
function parseAddress(record: JsonLdApartment): { address: string | null; city: string | null } {
  const raw = record.address;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return [o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode];
    })
    .flatMap((v) => clean(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    // The postal code and the province are identifiable wherever they landed, so they are
    // removed by shape instead of by position.
    .filter((s) => !POSTAL.test(s) && !PROVINCE.test(s));

  // The city is the last segment carrying no street number; everything before it is the street.
  const cityIndex = parts.map((s) => /\d/.test(s)).lastIndexOf(false);
  const city = cityIndex === -1 ? null : parts[cityIndex]!;
  const streets = cityIndex === -1 ? parts : parts.slice(0, cityIndex);
  // A bare number is half of a compound address, not an address. Prefer a segment that carries
  // both a number and a name, exactly as normalizeAddress does when it reads a street line.
  const address = streets.find((s) => /\d/.test(s) && /[A-Za-z]/.test(s)) ?? streets[0] ?? null;

  return { address, city };
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Latitude and longitude arrive as strings, not numbers. */
function coord(value: unknown): number | null {
  const n = Number(clean(value));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * The building record.
 *
 * Fails loudly rather than returning an empty page: a building page with no JSON-LD is either a
 * redesign or something that is not a building page, and both need a person. Silence here would
 * be indistinguishable from a building with nothing to rent.
 */
export function extractBuilding(html: string): JsonLdApartment {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  if (blocks.length === 0) throw new CapreitParseError('no JSON-LD block on the page');

  for (const [, body] of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body!);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const type = (entry as { '@type'?: unknown })['@type'];
      const isApartment = type === 'Apartment' || (Array.isArray(type) && type.includes('Apartment'));
      if (isApartment) return entry as JsonLdApartment;
    }
  }
  throw new CapreitParseError('no Apartment record in any JSON-LD block');
}

export interface CapreitBuilding {
  name: string;
  url: string;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  description: string | null;
  amenities: string[];
}

export function parseBuildingRecord(html: string): CapreitBuilding {
  const record = extractBuilding(html);
  const geo = first(record.geo as Record<string, unknown>[] | undefined);
  const amenities = (Array.isArray(record.amenityFeature) ? record.amenityFeature : [])
    .map((a) => clean((a as { name?: unknown })?.name ?? a))
    .filter(Boolean);

  return {
    name: clean(record.name),
    url: clean(record.url),
    ...parseAddress(record),
    lat: coord(geo?.latitude),
    lng: coord(geo?.longitude),
    description: clean(record.description) || null,
    amenities,
  };
}

/** `2 Bedroom + Den` → 2 beds and a den; `Bachelor` → zero beds. */
export function parseLayout(label: string): { beds: number; dens: number } | null {
  const text = label.toLowerCase();
  const dens = /\+\s*den/.test(text) ? 1 : 0;
  if (/bachelor|studio/.test(text)) return { beds: 0, dens };
  const beds = text.match(/(\d+)\s*bedroom/);
  return beds ? { beds: Number(beds[1]), dens } : null;
}

/**
 * `Available Immediately` is not a date, and must not become one.
 *
 * The profile treats a null as "as soon as possible", which is exactly what immediate
 * availability means. Inventing today's date instead would make the listing stale tomorrow.
 */
export function parseAvailability(text: string): string | null {
  if (/immediate/i.test(text)) return null;
  const match = text.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!match) return null;
  const parsed = new Date(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** `Starting at $1,605 - $1,690` → 1605. "Starting at" means the bottom of the range. */
export function parsePrice(text: string): number | null {
  const match = text.match(/\$\s*([\d,]+)/);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function hasUnqualifiedAmenity(amenities: string[], needles: string[], excluded: string[] = []): boolean {
  return amenities.some((a) => {
    // An asterisk is CAPREIT's own qualifier on the claim; it is not ours to resolve.
    if (a.includes('*')) return false;
    const lower = a.toLowerCase();
    if (excluded.some((n) => lower.includes(n))) return false;
    return needles.some((n) => lower.includes(n));
  });
}

const UNIT_BLOCK = /<li class="property-options-list-item"([^>]*)>([\s\S]*?)<\/li>\s*<\/ul>\s*<\/li>/g;

/**
 * Every rentable unit type in one building.
 *
 * A building page advertises the unit types the building *contains*, not what can be rented:
 * a `3 Bedroom` row marked `data-available="false"` with no price is a floor plan. Emitting those
 * would fill the feed with apartments nobody can take, and they would score well — the bedroom
 * count is real and only the availability is not. Both conditions are required, not either.
 *
 * A floorplan is a class of unit rather than a specific suite, the same as on Zumper. It is still
 * actionable: you can ask the building about that plan.
 */
export function parseBuildingPage(html: string): TriageListing[] {
  const lists = [...html.matchAll(/<ul class="property-options-list"/g)].length;
  if (lists === 0) throw new CapreitParseError('no unit list on the page');
  // Zumper's sixteen decoy `listables` keys are the precedent: taking the first match of a name
  // that turns out to be repeated returns something plausible and wrong. Twelve pages carried
  // exactly one of these; a second one means the page changed and a person should look.
  if (lists > 1) throw new CapreitParseError(`expected one unit list, found ${lists}`);

  const building = parseBuildingRecord(html);
  const slug = building.url.replace(/\/$/, '').split('/').pop() ?? 'unknown';
  const listings: TriageListing[] = [];
  const seen = new Map<string, number>();
  let blocks = 0;

  for (const [, attrs, body] of html.matchAll(UNIT_BLOCK)) {
    blocks += 1;
    if (!/data-available="true"/.test(attrs!)) continue;

    const label = body!.match(/icon-bedroom"><\/div>\s*([^<]+?)\s*<\/li>/)?.[1];
    const layout = label ? parseLayout(label) : null;
    const rentBase = parsePrice(body!.match(/item-price">([\s\S]*?)<\/div>/)?.[1] ?? '');
    if (!layout || rentBase === null) continue;

    // Stable across cycles as long as the building keeps offering the layout, which is the point:
    // a suffix keyed on position would mint a new id every time a plan was added or removed.
    const key = `${layout.beds}br${layout.dens > 0 ? `-den` : ''}`;
    const repeat = (seen.get(key) ?? 0) + 1;
    seen.set(key, repeat);

    listings.push({
      source: 'capreit',
      sourceId: `${slug}:${key}${repeat > 1 ? `-${repeat}` : ''}`,
      url: building.url,
      title: `${building.name} — ${clean(label)}`,
      // Building prose, thin but real: 155 characters on one measured page. The extraction layer
      // reads it as it reads any advertisement, and a structured positive still wins over it.
      rawText: building.description ? toSearchableText(building.description) : null,
      rentBase,
      parkingIncluded: hasUnqualifiedAmenity(building.amenities, PARKING_TAGS) ? true : null,
      parkingCost: null,
      utilitiesIncluded: UTILITY_TAGS.filter(([tag]) =>
        building.amenities.some((a) => a.toLowerCase().includes(tag)),
      ).map(([, name]) => name),
      totalMonthlyCost: rentBase,
      beds: layout.beds,
      // Declared by the source, which no other source here does. Zumper has no den field and no
      // prose in which one could be named, so every 2BR+den it publishes scores a tier low.
      dens: layout.dens,
      baths: null,
      hasLocker: hasUnqualifiedAmenity(building.amenities, LOCKER_TAGS, NOT_A_LOCKER) ? true : null,
      inSuiteLaundry: hasUnqualifiedAmenity(building.amenities, IN_SUITE_LAUNDRY_TAGS) ? true : null,
      address: building.address,
      city: building.city,
      lat: building.lat,
      lng: building.lng,
      availableFrom: parseAvailability(body!.match(/item-availability">\s*([^<]+?)\s*<\/div>/)?.[1] ?? ''),
      // Nothing on the page says when a unit was listed, and the sitemap's lastmod belongs to
      // the building rather than to any one plan.
      postedAt: null,
      buildingBuiltBefore2018: null,
    });
  }

  if (blocks === 0) throw new CapreitParseError(`${slug} rendered a unit list with no units in it`);
  return listings;
}

export interface CapreitSitemapEntry {
  url: string;
  citySlug: string;
  slug: string;
  lastModified: Date | null;
}

/**
 * The whole inventory, from one request.
 *
 * The sitemap is declared in robots.txt and carries `<lastmod>` for every property, which is the
 * same affordance Zumper's `modified_on` provides and arrives more cheaply: one request
 * enumerates the country and says which buildings changed.
 *
 * **The city in the URL is not authoritative.** A property listed under `toronto-on` redirects to
 * `north-york-on`; both are inside this profile's area, but the segment is a routing convenience
 * and the address on the building page is the fact.
 */
export function parseSitemap(xml: string, citySlugs: string[] = GTA_CITY_SLUGS): CapreitSitemapEntry[] {
  const entries: CapreitSitemapEntry[] = [];

  for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const url = block!.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!url) continue;
    // The French tree duplicates every property under a translated path.
    if (url.includes('/fr/')) continue;

    const path = url.match(/\/apartments-for-rent\/([a-z0-9-]+)-(?:on|qc|ab|bc|ns|nb|mb|sk|pe|nl)\/([^/]+)\//);
    if (!path) continue;
    if (!citySlugs.includes(path[1]!)) continue;

    const lastmod = block!.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1];
    const parsed = lastmod ? new Date(lastmod) : null;
    entries.push({
      url,
      citySlug: path[1]!,
      slug: path[2]!,
      lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    });
  }

  if (entries.length === 0) throw new CapreitParseError('sitemap contained no property URLs');
  return entries;
}

/** A sitemap entry in the shape the building cycle expects. */
export function toBuildingEntry(entry: CapreitSitemapEntry): BuildingEntry {
  return {
    sourceId: entry.slug,
    url: entry.url,
    name: entry.slug.replace(/-/g, ' '),
    address: null,
    city: null,
    lat: null,
    lng: null,
    minPrice: null,
    maxPrice: null,
    minBedrooms: null,
    maxBedrooms: null,
    floorplanCount: 0,
    modifiedOn: entry.lastModified,
    amenityTags: [],
  };
}

export const SITEMAP_URL = `${BASE}/property-sitemap1.xml`;
