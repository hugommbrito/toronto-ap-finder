import type { ListingSource as ListingSourceId, TriageListing } from '@/listings/listing.types';

/** A listing the source returned but could not be turned into a usable record. */
export interface UnparsableListing {
  sourceId: string;
  url: string | null;
  reason: string;
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

  fetchTriagePage(page: number): Promise<TriagePage>;

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

  fetchBuildingPage(page: number): Promise<BuildingPage>;

  /** One request, every floorplan the building offers, descriptions included. */
  fetchUnits(building: BuildingEntry): Promise<TriageListing[]>;
}

export interface ListingDetail {
  /** Advertisement body as HTML, ready for htmlToText(). */
  descriptionHtml: string;
  /** Source-specific lifecycle marker, when exposed. */
  status: string | null;
}
