import { describe, expect, it } from 'vitest';
import { applyVerdict } from './apply-verdict';
import { verdictSchema, type Verdict } from './listing-verifier';
import type { TriageListing } from '@/listings/listing.types';
import { buildSisterProfile } from '@/seed/sister-profile';
import type { TenantProfile } from '@/profiles/profile.schema';

/** The sister profile rejects split dwellings; the permissive one accepts them. */
const STRICT = buildSisterProfile(['x']);
const PERMISSIVE: TenantProfile = { ...STRICT, hard: { ...STRICT.hard, allowSplitDwelling: true } };

function listing(overrides: Partial<TriageListing> = {}): TriageListing {
  return {
    source: 'kijiji', sourceId: '1', url: 'u', title: 'Unit', rawText: 'body',
    rentBase: 2400, parkingIncluded: true, parkingCost: null, utilitiesIncluded: [],
    totalMonthlyCost: 2400, beds: 3, dens: 0, baths: 1, hasLocker: null, inSuiteLaundry: null,
    address: '1 Main St', city: 'Toronto', lat: 43.7, lng: -79.4,
    availableFrom: null, postedAt: null, buildingBuiltBefore2018: null,
    ...overrides,
  };
}

const verdict = (o: Partial<Verdict> = {}): Verdict => ({
  bedrooms: 3, dens: 0, isEntireUnit: true, isSplitDwelling: false,
  confidence: 'high', evidence: '', notes: '', ...o,
});

describe('applyVerdict', () => {
  it('does nothing when the verdict agrees with the source', () => {
    const outcome = applyVerdict(listing({ beds: 3 }), verdict({ bedrooms: 3 }), STRICT);
    expect(outcome.applied).toBe(false);
    expect(outcome.reject).toBeNull();
  });

  /** The ROSEMOUNT case: dropdown said 3, the ad said "2 Bedroom + Den - Main Flr. Unit". */
  it('scores the layout the advertisement describes, not the inflated one', () => {
    const outcome = applyVerdict(listing({ beds: 3, dens: 0 }), verdict({ bedrooms: 2, dens: 1, evidence: 'Well Maintained 2 Bedroom + Den - Main Flr. Unit' }), STRICT);
    expect(outcome.listing.beds).toBe(2);
    expect(outcome.listing.dens).toBe(1);
    expect(outcome.applied).toBe(true);
    expect(outcome.note).toContain('ad describes 2');
  });

  /** The "Private room 736 Spadina" class — priced like a room, filed like a 2BR. */
  it('rejects a room or shared space outright, whatever the bedroom count says', () => {
    const outcome = applyVerdict(listing({ beds: 2 }), verdict({ bedrooms: 2, isEntireUnit: false, evidence: 'Private den (approximately 7 x 11 ft)' }), STRICT);
    expect(outcome.reject?.reason).toBe('not_entire_unit');
    expect(outcome.applied).toBe(true);
  });

  /**
   * The guard that stops this becoming a second, less predictable source of truth: the
   * verdict may only ever reduce. A model that could also inflate could promote a listing on
   * its own say-so.
   */
  it('ignores a verdict claiming more bedrooms than the source', () => {
    const outcome = applyVerdict(listing({ beds: 2 }), verdict({ bedrooms: 4 }), STRICT);
    expect(outcome.listing.beds).toBe(2);
    expect(outcome.applied).toBe(false);
  });

  it('records but never acts on a low-confidence verdict', () => {
    const outcome = applyVerdict(listing({ beds: 3 }), verdict({ bedrooms: 1, isEntireUnit: false, confidence: 'low' }), STRICT);
    expect(outcome.applied).toBe(false);
    expect(outcome.reject).toBeNull();
    expect(outcome.listing.beds).toBe(3);
  });

  it('leaves a listing whose source never stated a bedroom count alone', () => {
    const outcome = applyVerdict(listing({ beds: null }), verdict({ bedrooms: 2 }), STRICT);
    expect(outcome.applied).toBe(false);
    expect(outcome.listing.beds).toBeNull();
  });
});

/** The JSON Schema sent to the API and this Zod schema must stay in step. */
describe('applyVerdict — split dwellings', () => {
  /**
   * A main-floor unit with the basement let separately: self-contained, but another
   * household lives through the floor and the entrance and laundry are shared.
   */
  it('rejects one part of a split house when the profile asks it to', () => {
    const outcome = applyVerdict(
      listing({ beds: 3 }),
      verdict({ isSplitDwelling: true, evidence: 'Well Maintained 2 Bedroom + Den - Main Flr. Unit' }),
      STRICT,
    );
    expect(outcome.reject?.reason).toBe('split_dwelling');
  });

  it('lets it through for a profile that allows them', () => {
    const outcome = applyVerdict(listing({ beds: 3 }), verdict({ isSplitDwelling: true }), PERMISSIVE);
    expect(outcome.reject).toBeNull();
  });

  it('leaves a whole house or a purpose-built apartment alone', () => {
    expect(applyVerdict(listing({ beds: 3 }), verdict({ isSplitDwelling: false }), STRICT).reject).toBeNull();
  });

  it('never acts on a low-confidence split verdict', () => {
    const outcome = applyVerdict(
      listing({ beds: 3 }),
      verdict({ isSplitDwelling: true, confidence: 'low' }),
      STRICT,
    );
    expect(outcome.reject).toBeNull();
    expect(outcome.applied).toBe(false);
  });
});

describe('verdictSchema', () => {
  it('accepts a well-formed verdict', () => {
    expect(verdictSchema.safeParse(verdict()).success).toBe(true);
  });

  it('rejects a malformed one rather than letting it drive a correction', () => {
    expect(verdictSchema.safeParse({ ...verdict(), confidence: 'certain' }).success).toBe(false);
    expect(verdictSchema.safeParse({ ...verdict(), bedrooms: 2.5 }).success).toBe(false);
    const { notes, ...missing } = verdict();
    expect(verdictSchema.safeParse(missing).success).toBe(false);
  });
});
