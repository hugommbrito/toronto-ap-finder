import type { BedroomRule } from '@/profiles/profile.schema';

export interface UnitLayout {
  /** Whole bedrooms. A "2 + den" unit is beds: 2, dens: 1. */
  beds: number | null;
  dens: number;
}

/**
 * Evaluates a profile's bedroom expression against a unit.
 *
 * Recursive over the discriminated union, with no knowledge of any particular profile —
 * a new tenant with different requirements is a new jsonb value, not a new code path.
 *
 * Returns null when the layout is unknown, so the caller can route the ad to needs_review
 * instead of rejecting it. An unparsed bedroom count is not the same as a small apartment.
 */
export function evaluateBedroomRule(rule: BedroomRule, layout: UnitLayout): boolean | null {
  switch (rule.kind) {
    case 'min':
      if (layout.beds === null) return null;
      return layout.beds >= rule.beds;

    case 'bedsPlusDen':
      if (layout.beds === null) return null;
      // Exactly this many bedrooms, plus at least one den. A 3BR does not satisfy a
      // "2 + den" rule by itself — it satisfies the sibling `min` rule in the anyOf.
      return layout.beds === rule.beds && layout.dens >= 1;

    case 'anyOf': {
      const results = rule.rules.map((r) => evaluateBedroomRule(r, layout));
      if (results.some((r) => r === true)) return true;
      // Only indeterminate if nothing matched and something was unknowable.
      if (results.some((r) => r === null)) return null;
      return false;
    }
  }
}

/**
 * Kijiji encodes a den as a half bedroom in `numberbedrooms`: 2.5 means "2 + Den",
 * 1.5 means "1 + Den". Confirmed against the site's own filter catalogue.
 * Everything downstream works in whole bedrooms plus a separate den count.
 */
export function splitHalfBedroomEncoding(value: number | null): UnitLayout {
  if (value === null || Number.isNaN(value)) return { beds: null, dens: 0 };
  const beds = Math.floor(value);
  const dens = value - beds >= 0.5 ? 1 : 0;
  return { beds, dens };
}
