import type { TriageListing } from '@/listings/listing.types';
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
 * Two guards keep this from becoming a second, less predictable source of truth:
 *
 * 1. **Low confidence never acts.** The model is asked to say when it is inferring rather
 *    than reading; when it says so, the verdict is recorded and nothing else happens.
 * 2. **It can only ever reduce.** A verdict that reports *more* bedrooms than the source is
 *    ignored for scoring — the failure this stage exists to catch is inflation, and a model
 *    that could also inflate would be able to promote a listing on its own say-so.
 *
 * A room rental is rejected outright regardless of bedroom count: "3 bedrooms" is true of the
 * house and irrelevant to the person renting one room in it.
 */
export function applyVerdict(listing: TriageListing, verdict: Verdict): VerdictOutcome {
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

  const structuredBeds = listing.beds;
  const inflated = structuredBeds !== null && verdict.bedrooms < structuredBeds;
  if (!inflated) {
    return { listing, reject: null, applied: false, note: null };
  }

  return {
    listing: { ...listing, beds: verdict.bedrooms, dens: verdict.dens },
    reject: null,
    applied: true,
    note:
      `listed as ${structuredBeds} bedrooms, ad describes ${verdict.bedrooms}` +
      `${verdict.dens > 0 ? ` + ${verdict.dens} den` : ''} — scored on the ad`,
  };
}
