import { describe, expect, it } from 'vitest';
import { evaluateBedroomRule, splitHalfBedroomEncoding } from './bedroom-rule';
import { bedroomRuleSchema, type BedroomRule } from '@/profiles/profile.schema';

/** The sister's actual rule: 3+ bedrooms, or exactly 2 bedrooms with a den. */
const SISTER_RULE: BedroomRule = {
  kind: 'anyOf',
  rules: [
    { kind: 'min', beds: 3 },
    { kind: 'bedsPlusDen', beds: 2 },
  ],
};

describe('splitHalfBedroomEncoding', () => {
  it('reads Kijiji half-bedroom values as bedrooms plus a den', () => {
    expect(splitHalfBedroomEncoding(2.5)).toEqual({ beds: 2, dens: 1 });
    expect(splitHalfBedroomEncoding(1.5)).toEqual({ beds: 1, dens: 1 });
    expect(splitHalfBedroomEncoding(3.5)).toEqual({ beds: 3, dens: 1 });
  });

  it('reads whole values as bedrooms with no den', () => {
    expect(splitHalfBedroomEncoding(3)).toEqual({ beds: 3, dens: 0 });
    expect(splitHalfBedroomEncoding(0)).toEqual({ beds: 0, dens: 0 });
  });

  it('propagates an unknown count instead of guessing zero', () => {
    expect(splitHalfBedroomEncoding(null)).toEqual({ beds: null, dens: 0 });
  });
});

describe('evaluateBedroomRule — the sister profile', () => {
  it('treats 3BR and 2BR+den as equivalent', () => {
    const threeBed = evaluateBedroomRule(SISTER_RULE, { beds: 3, dens: 0 });
    const twoPlusDen = evaluateBedroomRule(SISTER_RULE, { beds: 2, dens: 1 });
    expect(threeBed).toBe(true);
    expect(twoPlusDen).toBe(true);
  });

  it('accepts anything larger', () => {
    expect(evaluateBedroomRule(SISTER_RULE, { beds: 4, dens: 0 })).toBe(true);
    expect(evaluateBedroomRule(SISTER_RULE, { beds: 3, dens: 1 })).toBe(true);
  });

  it('rejects a plain 2BR without a den', () => {
    expect(evaluateBedroomRule(SISTER_RULE, { beds: 2, dens: 0 })).toBe(false);
  });

  it('rejects a 1BR even with a den', () => {
    expect(evaluateBedroomRule(SISTER_RULE, { beds: 1, dens: 1 })).toBe(false);
  });

  it('accepts the Kijiji 2.5 encoding end to end', () => {
    expect(evaluateBedroomRule(SISTER_RULE, splitHalfBedroomEncoding(2.5))).toBe(true);
    expect(evaluateBedroomRule(SISTER_RULE, splitHalfBedroomEncoding(2))).toBe(false);
    expect(evaluateBedroomRule(SISTER_RULE, splitHalfBedroomEncoding(1.5))).toBe(false);
  });

  it('is indeterminate rather than false when the layout is unknown', () => {
    expect(evaluateBedroomRule(SISTER_RULE, { beds: null, dens: 0 })).toBeNull();
  });
});

describe('evaluateBedroomRule — rule shapes in isolation', () => {
  it('bedsPlusDen requires exactly that bedroom count', () => {
    const rule: BedroomRule = { kind: 'bedsPlusDen', beds: 2 };
    expect(evaluateBedroomRule(rule, { beds: 2, dens: 1 })).toBe(true);
    expect(evaluateBedroomRule(rule, { beds: 3, dens: 1 })).toBe(false);
    expect(evaluateBedroomRule(rule, { beds: 2, dens: 0 })).toBe(false);
  });

  it('anyOf short-circuits to true even when a sibling is indeterminate', () => {
    const rule: BedroomRule = {
      kind: 'anyOf',
      rules: [
        { kind: 'min', beds: 3 },
        { kind: 'bedsPlusDen', beds: 2 },
      ],
    };
    // beds known, so nothing is indeterminate here; the point is the true wins.
    expect(evaluateBedroomRule(rule, { beds: 5, dens: 0 })).toBe(true);
  });

  it('nests arbitrarily deep without any code change', () => {
    const rule: BedroomRule = {
      kind: 'anyOf',
      rules: [
        { kind: 'anyOf', rules: [{ kind: 'min', beds: 6 }] },
        { kind: 'bedsPlusDen', beds: 1 },
      ],
    };
    expect(evaluateBedroomRule(rule, { beds: 1, dens: 1 })).toBe(true);
    expect(evaluateBedroomRule(rule, { beds: 6, dens: 0 })).toBe(true);
    expect(evaluateBedroomRule(rule, { beds: 2, dens: 2 })).toBe(false);
  });
});

describe('bedroomRuleSchema', () => {
  it('parses the recursive shape the profile stores', () => {
    expect(() => bedroomRuleSchema.parse(SISTER_RULE)).not.toThrow();
  });

  it('rejects an unknown rule kind rather than accepting it silently', () => {
    expect(() => bedroomRuleSchema.parse({ kind: 'atLeastish', beds: 2 })).toThrow();
  });
});
