import type { TriageListing } from '@/listings/listing.types';
import type { TenantProfile } from '@/profiles/profile.schema';
import type { Verdict } from './listing-verifier';

export interface VerdictOutcome {
  /** The listing as the advertisement text describes it, when the verdict was acted on. */
  listing: TriageListing;
  /** Set when the unit is not what the profile is looking for at all. */
  reject: { reason: string; detail: Record<string, unknown> } | null;
  /** True when the verdict changed the listing or rejected it, rather than only being recorded. */
  applied: boolean;
  /** Human-readable note for the notification and the audit row. */
  note: string | null;
}

/**
 * Decides what a verdict is allowed to change.
 *
 * Three guards keep this from becoming a second, less predictable source of truth:
 *
 * 1. **Low confidence never acts.** The model is asked to say when it is inferring rather
 *    than reading; when it says so, the verdict is recorded and nothing else happens.
 * 2. **On layout it can only ever reduce.** A verdict that reports *more* bedrooms than the
 *    source is ignored for scoring — the failure this stage exists to catch is inflation, and
 *    a model that could also inflate would be able to promote a listing on its own say-so.
 * 3. **On area and parking it can only ever fill a blank.** A structured field the source
 *    stated is never overwritten, and the one claim that would *promote* a listing —
 *    "parking included" — is only believed at high confidence; below that it degrades to
 *    "available on unstated terms", which the notification words honestly.
 *
 * A room rental is rejected outright regardless of bedroom count: "3 bedrooms" is true of the
 * house and irrelevant to the person renting one room in it.
 */
export function applyVerdict(
  listing: TriageListing,
  verdict: Verdict,
  profile: TenantProfile,
): VerdictOutcome {
  if (verdict.confidence === 'low') {
    return { listing, reject: null, applied: false, note: null };
  }

  if (!verdict.isEntireUnit) {
    return {
      listing,
      reject: {
        reason: 'not_entire_unit',
        detail: { evidence: verdict.evidence, notes: verdict.notes, confidence: verdict.confidence },
      },
      applied: true,
      note: 'advertised unit is a room or shared space, not a self-contained home',
    };
  }

  if (verdict.isSplitDwelling && !profile.hard.allowSplitDwelling) {
    return {
      listing,
      reject: {
        reason: 'split_dwelling',
        detail: { evidence: verdict.evidence, notes: verdict.notes, confidence: verdict.confidence },
      },
      applied: true,
      note: 'part of a house let in separate units — another household occupies the rest',
    };
  }

  const updates: Partial<TriageListing> = {};
  const notes: string[] = [];

  const structuredBeds = listing.beds;
  if (structuredBeds !== null && verdict.bedrooms < structuredBeds) {
    updates.beds = verdict.bedrooms;
    updates.dens = verdict.dens;
    notes.push(
      `listed as ${structuredBeds} bedrooms, ad describes ${verdict.bedrooms}` +
        `${verdict.dens > 0 ? ` + ${verdict.dens} den` : ''} — scored on the ad`,
    );
  }

  if (listing.areaSqft === null && verdict.areaSqft !== null) {
    updates.areaSqft = verdict.areaSqft;
    notes.push(`ad states ${verdict.areaSqft} sq ft`);
  }

  // Only when the source and the extraction rules said nothing at all — a structured claim,
  // a price, or an existing availability fact all outrank a model reading.
  const parkingUnknown =
    listing.parkingIncluded === null && listing.parkingCost === null && listing.parkingAvailable !== true;
  if (parkingUnknown) {
    switch (verdict.parking) {
      case 'included':
        if (verdict.confidence === 'high') {
          updates.parkingIncluded = true;
          notes.push('ad states parking is included');
        } else {
          updates.parkingAvailable = true;
          notes.push('ad suggests parking is included — treated as available, terms unstated');
        }
        break;
      case 'paid_extra':
      case 'available':
        // No price field travels with the verdict, so the cost cannot be added to the
        // monthly total; "exists on unstated terms" is the honest maximum.
        updates.parkingAvailable = true;
        notes.push('ad offers parking, terms not carried into the total');
        break;
      case 'none':
        // The re-run of the hard filters on the corrected listing turns this into a
        // no_parking rejection for profiles that require parking.
        updates.parkingIncluded = false;
        notes.push('ad says there is no parking');
        break;
      case 'not_stated':
        break;
    }
  }

  if (Object.keys(updates).length === 0) {
    return { listing, reject: null, applied: false, note: null };
  }

  return {
    listing: { ...listing, ...updates },
    reject: null,
    applied: true,
    note: notes.join('; '),
  };
}
