/**
 * Normalised listing. One row per advertisement per source; the same physical unit
 * appearing on three sites produces three rows sharing one fingerprint.
 *
 * Tri-state booleans are deliberate. An absent field is `null`, never `false` —
 * "the ad does not mention a locker" and "the unit has no locker" are different
 * facts, and collapsing them silently discards good listings.
 */
export type ListingSource = 'kijiji' | 'rentals_ca' | 'zumper' | 'padmapper' | 'capreit';

export interface Listing {
  id: string;
  source: ListingSource;
  sourceId: string;
  url: string;
  fingerprint: string;
  title: string;
  /** Full advertisement body, plain text. Only populated after the hydration stage. */
  rawText: string | null;

  rentBase: number;
  parkingIncluded: boolean | null;
  parkingCost: number | null;
  utilitiesIncluded: string[];
  /** Derived: rentBase + parkingCost (when not included) + estimated uncovered utilities. */
  totalMonthlyCost: number;

  /** Whole bedrooms only. A "2 + den" unit is beds: 2, dens: 1 — never beds: 2.5. */
  beds: number | null;
  dens: number;
  baths: number | null;

  hasLocker: boolean | null;
  inSuiteLaundry: boolean | null;

  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;

  availableFrom: string | null;
  /** When the source says the ad was published, not when we first saw it. */
  postedAt: Date | null;
  buildingBuiltBefore2018: boolean | null;

  firstSeenAt: Date;
  lastSeenAt: Date;
  hydratedAt: Date | null;
  delistedAt: Date | null;
}

/** The subset a source adapter can fill from a search-results page, before hydration. */
export type TriageListing = Omit<
  Listing,
  'id' | 'firstSeenAt' | 'lastSeenAt' | 'hydratedAt' | 'delistedAt' | 'fingerprint'
>;

/** Rebuilds the in-memory shape from a stored row, so a hydrated listing never needs refetching. */
export function listingFromRow(row: {
  source: string;
  sourceId: string;
  url: string;
  title: string;
  rawText: string | null;
  rentBase: string;
  parkingIncluded: boolean | null;
  parkingCost: string | null;
  utilitiesIncluded: string[];
  totalMonthlyCost: string;
  beds: number | null;
  dens: number;
  baths: string | null;
  hasLocker: boolean | null;
  inSuiteLaundry: boolean | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  availableFrom: string | null;
  postedAt: Date | null;
  buildingBuiltBefore2018: boolean | null;
}): TriageListing {
  return {
    source: row.source as ListingSource,
    sourceId: row.sourceId,
    url: row.url,
    title: row.title,
    rawText: row.rawText,
    rentBase: Number(row.rentBase),
    parkingIncluded: row.parkingIncluded,
    parkingCost: row.parkingCost === null ? null : Number(row.parkingCost),
    utilitiesIncluded: row.utilitiesIncluded,
    totalMonthlyCost: Number(row.totalMonthlyCost),
    beds: row.beds,
    dens: row.dens,
    baths: row.baths === null ? null : Number(row.baths),
    hasLocker: row.hasLocker,
    inSuiteLaundry: row.inSuiteLaundry,
    address: row.address,
    city: row.city,
    lat: row.lat,
    lng: row.lng,
    availableFrom: row.availableFrom,
    postedAt: row.postedAt,
    buildingBuiltBefore2018: row.buildingBuiltBefore2018,
  };
}

export interface Match {
  listingId: string;
  profileId: string;
  score: number;
  /** Mandatory. Without per-component contributions the weights cannot be calibrated. */
  breakdown: Record<string, number>;
  notifiedAt: Date | null;
}
