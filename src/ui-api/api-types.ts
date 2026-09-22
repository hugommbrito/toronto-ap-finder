/**
 * The contract between the Nest API under /api and the browser UI in web/.
 *
 * This file has no imports, on purpose. It is the one file both TypeScript roots compile — Nest
 * because it lives under src/, the web bundle through the `@shared` alias — and an import of
 * zod, drizzle or a Nest type here would drag that whole dependency tree into the browser's
 * typecheck. Dates travel as ISO strings for the same reason: a Date does not survive JSON.
 */

export type ListingStatus = 'none' | 'favourite' | 'dismissed' | 'contacted';
export type DaycareCoverage = 'full' | 'presenceOnly' | 'none';
export type SortKey = 'score' | 'rent' | 'newest' | 'posted' | 'area';

/** What the UI needs to know about a profile. Never the Telegram chat ids. */
export interface ProfileSummary {
  id: string;
  label: string;
  minScore: number;
  /** Component weights, so a breakdown can show "of a possible N" next to each bar. */
  weights: Record<string, number>;
  /** Index in this array is the `?tier=` value. Empty when the profile defines no ladder. */
  bedroomTiers: Array<{ label: string; value: number }>;
  cities: string[];
  excludeAreas: string[];
  targetRent: number | null;
  totalRentMax: number;
  daycare: { radiusM: number; count: number; ageGroup: string } | null;
  /** How far out transit was measured — the profile's decay distance. */
  transitRadiusM: number;
}

/** The stored listing, minus the advertisement body. The body is only on the detail. */
export interface ListingCore {
  id: string;
  source: string;
  sourceId: string;
  url: string;
  fingerprint: string;
  title: string;
  rentBase: number;
  parkingIncluded: boolean | null;
  parkingCost: number | null;
  parkingAvailable: boolean | null;
  utilitiesIncluded: string[];
  totalMonthlyCost: number;
  beds: number | null;
  dens: number;
  baths: number | null;
  areaSqft: number | null;
  hasLocker: boolean | null;
  inSuiteLaundry: boolean | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  postedAt: string | null;
  availableFrom: string | null;
  buildingBuiltBefore2018: boolean | null;
  firstSeenAt: string;
  lastSeenAt: string;
  hydratedAt: string | null;
  delistedAt: string | null;
}

export interface ListingState {
  status: ListingStatus;
  note: string | null;
  updatedAt: string | null;
}

export interface RentSafeSummary {
  rsn: string;
  score: number;
  evaluatedOn: string | null;
  yearBuilt: number | null;
  /** 'exact' | 'range' | 'geo' — how the listing was tied to the building. */
  matchTier: string | null;
}

export interface FeedItem {
  listing: ListingCore;
  score: number;
  /** Per-component contribution in final points; the parts sum to `score`. */
  breakdown: Record<string, number>;
  /**
   * When this (listing, profile) pair was first scored. Not "last": the upsert that rewrites the
   * score on every re-score leaves created_at alone, so this is a first-seen date and the UI
   * must not label it as anything fresher.
   */
  firstScoredAt: string;
  /** `status: 'none'` when nobody has decided anything about it yet. */
  state: ListingState;
  rentsafe: RentSafeSummary | null;
  notifiedAt: string | null;
  /** Other advertisements of the same physical unit, on this or another portal. */
  duplicates: number;
  /** Pre-1998 area name from the boundary file; null outside the 416 or without coordinates. */
  area: string | null;
  tier: { index: number; label: string } | null;
}

export interface FeedPage {
  items: FeedItem[];
  total: number;
  page: number;
  limit: number;
  applied: { minScore: number; sort: SortKey; includeDelisted: boolean; includeDismissed: boolean };
  /** Counted before the page is cut and before city/area/source narrow it, so chips show what exists. */
  facets: {
    sources: Array<{ value: string; count: number }>;
    cities: Array<{ value: string; count: number }>;
    areas: Array<{ value: string; count: number }>;
  };
}

export interface ReachableLine {
  line: string;
  station: string;
  distanceM: number;
  lat: number;
  lng: number;
}

/** The same facts the Telegram message carries, so the card and the message never disagree. */
export interface GeoContext {
  reachableLines: ReachableLine[];
  transitRadiusM: number;
  /** See notification.types.ts for what `coverage` allows `total` to claim. */
  daycaresNearby: { total: number; cwelcc: number; radiusM: number; coverage: DaycareCoverage };
  nearestDaycare: { name: string; distanceM: number; cwelcc: boolean; lat: number; lng: number } | null;
  mapStops: Array<{ label: string; lat: number; lng: number }>;
}

/** Everything the map draws, with coordinates. Distances are walking metres, like the score. */
export interface MapPoints {
  stations: Array<{
    id: string;
    name: string;
    line: string;
    status: 'operational' | 'future';
    expectedYear: number | null;
    lat: number;
    lng: number;
    distanceM: number;
  }>;
  daycares: Array<{
    id: string;
    name: string;
    lat: number;
    lng: number;
    distanceM: number;
    cwelcc: boolean;
    capacityKnown: boolean;
  }>;
}

export interface VerificationView {
  model: string;
  bedrooms: number | null;
  dens: number | null;
  isEntireUnit: boolean | null;
  isSplitDwelling: boolean | null;
  areaSqft: number | null;
  parking: string | null;
  confidence: string | null;
  /** The phrase the verdict rests on. */
  evidence: string | null;
  notes: string | null;
  applied: boolean;
  error: string | null;
  createdAt: string;
}

export interface RentSafeFull extends RentSafeSummary {
  siteAddress: string;
  confirmedStoreys: number | null;
  confirmedUnits: number | null;
  propertyType: string | null;
  wardName: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Sibling {
  id: string;
  source: string;
  url: string;
  title: string;
  rentBase: number;
  totalMonthlyCost: number;
  lastSeenAt: string;
  delistedAt: string | null;
  /** Null when this profile never scored that advertisement. */
  score: number | null;
}

export interface ListingDetail extends FeedItem {
  rawText: string | null;
  verification: VerificationView | null;
  rentsafeFull: RentSafeFull | null;
  /** Null only when the listing has no coordinates. */
  geo: GeoContext | null;
  map: MapPoints | null;
  siblings: Sibling[];
  /** Components with weight > 0 that returned null and so dropped out of the denominator. */
  skipped: string[];
  /** Open needs_review rows: what the ad never stated. */
  unverified: Array<{ field: string; reason: string }>;
}

export interface Summary {
  lastCycleAt: string | null;
  minutesSinceLastCycle: number | null;
  pausedSources: string[];
  counts: {
    scored: number;
    aboveMinScore: number;
    newSince24h: number;
    delisted: number;
    favourites: number;
    contacted: number;
    dismissed: number;
  };
}

/** Body of PUT /api/listings/:id/state. Either field alone is a valid partial update. */
export interface StateUpdate {
  status?: ListingStatus;
  note?: string | null;
}

/**
 * What the funnel tab reads from GET /api/funnel. A structural subset of `OperationsReport`
 * (src/operations/operations.service.ts), restated here so the browser needs none of its imports.
 */
export interface FunnelReport {
  window: { hours: number; since: string; now: string };
  lastCycleAt: string | null;
  minutesSinceLastCycle: number | null;
  sources: Record<
    string,
    {
      cycles: number;
      failed: number;
      paused: boolean;
      pausedReason: string | null;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastError: string | null;
    }
  >;
  totals: Record<string, number>;
  /** rejection_log.reason → count over the window. */
  funnel: Record<string, number>;
  openReviews: number;
  runs: Array<{
    kind: string;
    source: string | null;
    startedAt: string;
    durationSec: number;
    ok: boolean;
    errors: string[];
  }>;
}
