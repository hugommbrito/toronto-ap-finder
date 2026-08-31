import type { TriageListing } from '@/listings/listing.types';
import { cityFromAddress } from '@/geo/address';
import { splitHalfBedroomEncoding } from '@/scoring/bedroom-rule';
import type { ListingDetail, SearchTarget, TriagePage, UnparsableListing } from '../source.interface';

/**
 * Pure parsing for Kijiji. No network, no database — every function here is driven by the
 * fixtures under test/fixtures/kijiji/, so the suite stays deterministic and offline.
 *
 * Kijiji server-renders its Apollo cache into the page; see docs/sources/kijiji.md for how
 * this was established and what each attribute encoding means.
 */

const NEXT_DATA_PATTERN =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

export class KijijiParseError extends Error {
  constructor(message: string) {
    super(`Kijiji parse failed: ${message}`);
    this.name = 'KijijiParseError';
  }
}

/**
 * Throws rather than returning empty.
 *
 * Zero listings and "nothing new today" are indistinguishable from the outside, so a
 * structural change at the source has to be loud. A silent empty result is how a monitor
 * dies without anyone noticing.
 */
export function extractNextData(html: string): unknown {
  const match = NEXT_DATA_PATTERN.exec(html);
  if (!match?.[1]) {
    throw new KijijiParseError('no __NEXT_DATA__ script tag — the page structure changed');
  }
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    throw new KijijiParseError(`__NEXT_DATA__ was not valid JSON: ${(err as Error).message}`);
  }
}

interface ApolloAttribute {
  canonicalName?: string;
  canonicalValues?: string[];
}

interface ApolloListing {
  __typename?: string;
  id?: string;
  title?: string;
  description?: string;
  url?: string;
  activationDate?: string;
  status?: string;
  price?: { amount?: number };
  location?: {
    name?: string;
    address?: string;
    coordinates?: { latitude?: number; longitude?: number };
  };
  attributes?: { all?: ApolloAttribute[] };
}

function apolloState(nextData: unknown): Record<string, unknown> {
  const state = (nextData as { props?: { pageProps?: { __APOLLO_STATE__?: unknown } } })?.props
    ?.pageProps?.__APOLLO_STATE__;
  if (!state || typeof state !== 'object') {
    throw new KijijiParseError('__APOLLO_STATE__ missing from the page payload');
  }
  return state as Record<string, unknown>;
}

function listingEntries(state: Record<string, unknown>): ApolloListing[] {
  return Object.entries(state)
    .filter(([key]) => key.startsWith('RealEstateListing:'))
    .map(([, value]) => value as ApolloListing);
}

function attributeMap(listing: ApolloListing): Map<string, string> {
  const map = new Map<string, string>();
  for (const attr of listing.attributes?.all ?? []) {
    const name = attr.canonicalName;
    const value = attr.canonicalValues?.[0];
    if (name && value !== undefined) map.set(name, value);
  }
  return map;
}

function numeric(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Kijiji writes `0` both for "no" and for "the poster left it blank", and the API gives no
 * way to tell them apart — 35 of 46 sampled ads reported `storagelocker: 0`. Treating that
 * as `false` would invent a fact and quietly bury good listings, so only `1` is believed
 * here and everything else stays unknown for the text extraction stage to settle.
 */
function tristateFromAttribute(raw: string | undefined): boolean | null {
  return raw === '1' ? true : null;
}

const UTILITY_ATTRIBUTES: Record<string, string> = {
  heat: 'heat',
  water: 'water',
  hydro: 'hydro',
  cabletv: 'cable',
  internet: 'internet',
};

export function parseSearchPage(nextData: unknown): TriagePage {
  const state = apolloState(nextData);
  const raw = listingEntries(state);

  if (raw.length === 0) {
    throw new KijijiParseError('page contained no RealEstateListing entries');
  }

  const listings: TriageListing[] = [];
  const unparsable: UnparsableListing[] = [];

  for (const item of raw) {
    const sourceId = item.id;
    const url = item.url ?? null;
    if (!sourceId || !url) {
      unparsable.push({ sourceId: sourceId ?? '(unknown)', url, reason: 'missing id or url' });
      continue;
    }

    // price.amount is in cents. Ads posted as "Please Contact" carry no amount at all.
    const cents = item.price?.amount;
    if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) {
      unparsable.push({ sourceId, url, reason: 'no listed price' });
      continue;
    }
    const rentBase = cents / 100;

    const attrs = attributeMap(item);
    const layout = splitHalfBedroomEncoding(numeric(attrs.get('numberbedrooms')));
    // Bathrooms arrive multiplied by ten: 10 = 1.0, 15 = 1.5.
    const bathsRaw = numeric(attrs.get('numberbathrooms'));
    const parkingSpots = numeric(attrs.get('numberparkingspots'));

    const utilitiesIncluded = Object.entries(UTILITY_ATTRIBUTES)
      .filter(([attribute]) => attrs.get(attribute) === '1')
      .map(([, utility]) => utility);

    const coords = item.location?.coordinates;

    listings.push({
      source: 'kijiji',
      sourceId,
      url,
      title: item.title ?? '',
      // Search pages truncate the body to ~200 characters; the real text needs hydration.
      rawText: null,
      rentBase,
      parkingIncluded: parkingSpots !== null && parkingSpots >= 1 ? true : null,
      parkingCost: null,
      utilitiesIncluded,
      totalMonthlyCost: rentBase,
      beds: layout.beds,
      dens: layout.dens,
      baths: bathsRaw === null ? null : bathsRaw / 10,
      hasLocker: tristateFromAttribute(attrs.get('storagelocker')),
      inSuiteLaundry: tristateFromAttribute(attrs.get('laundryinunit')),
      address: item.location?.address ?? null,
      /**
       * The address first, the label second.
       *
       * `location.name` is the *region the search ran in*, not the municipality — it reads
       * "Mississauga / Peel Region" for an ad in Brampton and "Kitchener / Waterloo" for one in
       * Orangeville. That was invisible while the only target was Toronto, whose label happens
       * to be a municipality. `location.address` carries the real one.
       */
      city: cityFromAddress(item.location?.address) ?? item.location?.name ?? null,
      lat: typeof coords?.latitude === 'number' ? coords.latitude : null,
      lng: typeof coords?.longitude === 'number' ? coords.longitude : null,
      availableFrom: null,
      // activationDate is the real publication time; sortingDate moves when an ad is bumped.
      postedAt: item.activationDate ? new Date(item.activationDate) : null,
      buildingBuiltBefore2018: null,
    });
  }

  return { listings, unparsable, pagination: parsePagination(state) };
}

function parsePagination(state: Record<string, unknown>): TriagePage['pagination'] {
  const root = state.ROOT_QUERY as Record<string, unknown> | undefined;
  const key = Object.keys(root ?? {}).find((k) => k.startsWith('searchResultsPageByUrl'));
  const page = key ? (root?.[key] as { pagination?: TriagePage['pagination'] }) : undefined;
  const pagination = page?.pagination;
  if (!pagination) return { offset: 0, limit: 0, totalCount: 0 };
  return {
    offset: pagination.offset ?? 0,
    limit: pagination.limit ?? 0,
    totalCount: pagination.totalCount ?? 0,
  };
}

/** Detail pages carry the complete advertisement body, plus a lifecycle status. */
export function parseDetailPage(nextData: unknown): ListingDetail {
  const state = apolloState(nextData);
  const [listing] = listingEntries(state);
  if (!listing) {
    throw new KijijiParseError('detail page contained no RealEstateListing entry');
  }
  return {
    descriptionHtml: listing.description ?? '',
    status: listing.status ?? null,
  };
}

/**
 * Path-based URLs only. Every query-string search filter is disallowed by Kijiji's
 * robots.txt, and the bedroom filter has no path equivalent at all — which is why triage
 * filters in memory. The plain path already sorts newest-first.
 */
export function buildSearchUrl(page: number, target: KijijiTarget = KIJIJI_TARGETS[0]!, categoryId = 37): string {
  const base = `https://www.kijiji.ca/b-apartments-condos/${target.slug}`;
  const suffix = `c${categoryId}l${target.locationId}`;
  return page <= 1 ? `${base}/${suffix}` : `${base}/page-${page}/${suffix}`;
}

/**
 * A Kijiji region: the human slug and the numeric id must agree, which is why they travel
 * together. `locationId` used to be a parameter while the slug stayed hardcoded as
 * `city-of-toronto`, so passing a different id emitted an internally inconsistent URL that
 * happened to still resolve.
 *
 * **Kijiji's granularity is regional, not municipal**, and that has consequences the profile has
 * to absorb:
 *
 * - `mississauga-peel-region` covers all of Peel, so it returns Brampton by the hundred. The
 *   `excludeAreas: ['Brampton']` entry in the profile stopped being belt-and-braces the moment
 *   this target was added — it is now the only thing filtering it out.
 * - There is no Cambridge region at all; Cambridge listings arrive inside
 *   `kitchener-waterloo` alongside Kitchener, Waterloo and the townships, and `hard.cities` is
 *   what narrows them down.
 *
 * So these targets deliberately over-fetch, and the city allowlist is load-bearing rather than
 * decorative. That is the same trade CAPREIT already makes with its national sitemap.
 */
export interface KijijiTarget extends SearchTarget {
  slug: string;
  locationId: number;
}

export const KIJIJI_TARGETS: readonly KijijiTarget[] = [
  { key: 'toronto', label: 'City of Toronto', slug: 'city-of-toronto', locationId: 1700273 },
  { key: 'peel', label: 'Mississauga / Peel Region', slug: 'mississauga-peel-region', locationId: 1700276 },
  { key: 'waterloo', label: 'Kitchener / Waterloo (incl. Cambridge)', slug: 'kitchener-waterloo', locationId: 1700212 },
];
