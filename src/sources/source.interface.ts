import type { ListingSource as ListingSourceId, TriageListing } from '@/listings/listing.types';

/** A listing the source returned but could not be turned into a usable record. */
export interface UnparsableListing {
  sourceId: string;
  url: string | null;
  reason: string;
}

/**
 * One place a source can be pointed at.
 *
 * Sources took no location at all, because there was only ever one: `hard.cities` filtered what
 * had already arrived, and what arrived was always Toronto. Adding Mississauga and Cambridge to
 * the allowlist would therefore have widened nothing — the allowlist is an accept filter, and
 * this is the query.
 *
 * Passed as an argument rather than being baked into an instance per region, deliberately: the
 * `RateLimiter` circuit lives on the source instance, so two instances hitting kijiji.ca would
 * pace independently and double the real request rate against one host. `registry.health()` is
 * also keyed on `name`, so per-region instances would silently collapse into one another there.
 *
 * `key` is stable and persisted (`cycle_runs.target`), because the rotation reads it back.
 */
export interface SearchTarget {
  /** Stable, lowercase, no colons — it is stored and compared. e.g. 'peel'. */
  key: string;
  /** For logs and error messages. */
  label: string;
}

export interface TriagePage {
  listings: TriageListing[];
  /**
   * Never silently dropped. An ad with "Please Contact" instead of a price is a real
   * listing we cannot score, and it belongs in rejection_log where it can be counted.
   */
  unparsable: UnparsableListing[];
  pagination: { offset: number; limit: number; totalCount: number };
}

/**
 * What every source can be asked about itself, whatever it fetches.
 *
 * These three members already existed on both concrete classes and on **neither** interface,
 * which is why the pipeline had to hold a source twice — once typed as the interface to fetch
 * with, once as the class to ask whether it was paused. Declaring them here is what lets health,
 * alerting and the operations route treat N sources uniformly instead of naming Kijiji.
 */
export interface SourceHealth {
  readonly name: ListingSourceId;
  readonly paused: boolean;
  readonly stats: { requests: number; paused: boolean; reason: string | null };
  /** Called at the start of a cycle: the gap between cycles is the backoff. */
  resetIfCooledDown(cooldownMs: number): boolean;
}

/**
 * Every source implements the same two stages.
 *
 * Triage is cheap — one request per page of results, using whatever the source structures
 * for free. Hydration costs one request per listing, so it only runs for what survived
 * triage.
 */
export interface UnitListingSource extends SourceHealth {
  readonly granularity?: 'unit';
  /** Floor between requests. Section 13 of the brief sets a 2 s minimum. */
  readonly minIntervalMs: number;

  /**
   * Everywhere this source can be pointed. Never empty.
   *
   * The pipeline visits **one per cycle, in rotation**, rather than all of them: Kijiji's limit
   * is a rolling budget and three regions at full depth would be ~75 requests in one burst,
   * which is the shape that earned a 429 at a 2 s gap.
   */
  readonly searchTargets: readonly SearchTarget[];

  fetchTriagePage(page: number, target: SearchTarget): Promise<TriagePage>;

  /** Full advertisement body plus anything only the detail page knows. */
  fetchDetail(listing: TriageListing): Promise<ListingDetail>;
}

/**
 * A triage entry that is not a listing.
 *
 * Some sources advertise a *building* — a price range over many floorplans — and the units
 * only exist on the building's own page. Nothing here can be scored: "$2,169–$3,809, 1–3BR"
 * does not answer "is this a 3BR under $2,700?". These entries are containers to be opened.
 */
export interface BuildingEntry {
  sourceId: string;
  url: string;
  name: string;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** Range over the whole building, useful only for skipping what cannot possibly qualify. */
  minPrice: number | null;
  maxPrice: number | null;
  minBedrooms: number | null;
  maxBedrooms: number | null;
  floorplanCount: number;
  /**
   * Advances whenever any floorplan changes. A building whose value has not moved since we
   * last opened it holds nothing new, which is what makes sweeping the city affordable.
   */
  modifiedOn: Date | null;
  amenityTags: string[];
}

export interface BuildingPage {
  buildings: BuildingEntry[];
  unparsable: UnparsableListing[];
  pagination: { offset: number; limit: number; totalCount: number };
}

/**
 * A source whose search results are buildings rather than units.
 *
 * Kept as its own interface rather than bolted onto ListingSource: the two stages mean
 * different things here. Opening one building yields *many* listings, already hydrated,
 * so there is no second per-listing request.
 */
export interface BuildingListingSource extends SourceHealth {
  readonly minIntervalMs: number;
  readonly granularity: 'building';
  /**
   * How long a building may go unopened before it is due again regardless of any watermark.
   *
   * Required, not optional, and that is the point. A source with a watermark barely needs it, but
   * making it optional would let a source with **no** watermark be added without anyone deciding
   * how it gets re-checked — and that source's buildings would then be opened on every single
   * cycle, forever, while the log looked healthy.
   */
  readonly refreshEveryMs: number;

  /** As for unit sources. A source with one entry simply never rotates. */
  readonly searchTargets: readonly SearchTarget[];

  fetchBuildingPage(page: number, target: SearchTarget): Promise<BuildingPage>;

  /** One request, every floorplan the building offers, descriptions included. */
  fetchUnits(building: BuildingEntry): Promise<TriageListing[]>;
}

export interface ListingDetail {
  /** Advertisement body as HTML, ready for htmlToText(). */
  descriptionHtml: string;
  /** Source-specific lifecycle marker, when exposed. */
  status: string | null;
}

/**
 * The target a source should visit next: whichever it has gone longest without.
 *
 * Pure, and separated from the database read on purpose — the selection rule is the part worth
 * testing, and it should not need Postgres to prove.
 *
 * A target absent from `lastVisited` has never been visited and sorts ahead of every visited
 * one, so a newly added region backfills before the established ones refresh. Ties resolve to
 * declaration order, which keeps the choice deterministic rather than dependent on Map order.
 */
export function pickLeastRecentlyVisited(
  targets: readonly SearchTarget[],
  lastVisited: ReadonlyMap<string, Date>,
): SearchTarget {
  let chosen = targets[0]!;
  let oldest = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const at = lastVisited.get(target.key);
    const age = at === undefined ? -1 : at.getTime();
    if (age < oldest) {
      oldest = age;
      chosen = target;
    }
  }

  return chosen;
}
