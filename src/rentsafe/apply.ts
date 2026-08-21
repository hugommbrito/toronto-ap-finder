import type { TriageListing } from '@/listings/listing.types';
import { builtBeforeRentControl } from '@/seed/rentsafe';
import type { RentSafeBuilding } from './rentsafe.index';

/**
 * What a matched building tells us about the listing, beyond its score.
 *
 * Only ever fills a gap. `buildingBuiltBefore2018` is left alone when the listing already carries
 * a value, on the same principle the extraction layer follows: a structured positive from the
 * source is not something a secondary dataset gets to overrule.
 *
 * This is the free half of the enrichment. `rentControlled` has been a registered scoring
 * component with a weight of 5 since it was written, and null for every listing ever scored,
 * because neither parser can know the year a building went up. The City's file carries it for
 * 6,071 of 6,090 rows.
 */
export function applyRentSafe(listing: TriageListing, building: RentSafeBuilding): TriageListing {
  if (listing.buildingBuiltBefore2018 !== null) return listing;

  const built = builtBeforeRentControl(building.yearBuilt);
  if (built === null) return listing;

  return { ...listing, buildingBuiltBefore2018: built };
}
