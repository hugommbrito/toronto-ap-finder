import type { TriageListing } from '@/listings/listing.types';

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
 * Every source implements the same two stages.
 *
 * Triage is cheap — one request per page of results, using whatever the source structures
 * for free. Hydration costs one request per listing, so it only runs for what survived
 * triage.
 */
export interface ListingSource {
  readonly name: string;
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
export interface BuildingListingSource {
  readonly name: string;
  readonly minIntervalMs: number;
  readonly granularity: 'building';

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
