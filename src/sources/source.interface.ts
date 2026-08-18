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
  /** Floor between requests. Section 13 of the brief sets a 2 s minimum. */
  readonly minIntervalMs: number;

  fetchTriagePage(page: number): Promise<TriagePage>;

  /** Full advertisement body plus anything only the detail page knows. */
  fetchDetail(listing: TriageListing): Promise<ListingDetail>;
}

export interface ListingDetail {
  /** Advertisement body as HTML, ready for htmlToText(). */
  descriptionHtml: string;
  /** Source-specific lifecycle marker, when exposed. */
  status: string | null;
}
