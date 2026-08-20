import { describe, expect, it } from 'vitest';
import { buildSisterProfile } from '@/seed/sister-profile';
import { applyPlan, planProfileSync, sameValue, type ProfileColumns } from './sync-profile';

const code = buildSisterProfile(['chat']);

/** The row as it was stored before `excludeAreas` existed, with a hand-tuned minScore. */
function storedBeforeAreas(): ProfileColumns {
  const { excludeAreas: _dropped, ...hard } = code.hard;
  return {
    hard: { ...hard, cities: ['Toronto', 'North York', 'Etobicoke', 'Scarborough', 'East York'] } as typeof code.hard,
    soft: code.soft,
    notify: { ...code.notify, minScore: 72 },
  };
}

describe('planProfileSync', () => {
  it('treats a field added in code as an addition — there is no tuning to lose', () => {
    const plan = planProfileSync(code, storedBeforeAreas());
    expect(plan.additions).toEqual([
      { column: 'hard', key: 'excludeAreas', value: ['Scarborough', 'East York', 'Brampton'] },
    ]);
  });

  it('leaves a tuned number alone, even though the code disagrees with it', () => {
    // The whole reason not to use --force-profiles: minScore was raised in the database.
    const plan = planProfileSync(code, storedBeforeAreas());
    const minScore = plan.conflicts.find((c) => c.key === 'minScore');
    expect(minScore).toMatchObject({ column: 'notify', stored: 72, code: 65, overwrite: false });
    expect(applyPlan(storedBeforeAreas(), plan).notify.minScore).toBe(72);
  });

  it('pushes a conflicting key only when it is named', () => {
    const plan = planProfileSync(code, storedBeforeAreas(), ['hard.cities']);
    const merged = applyPlan(storedBeforeAreas(), plan);
    expect(merged.hard.cities).toEqual(['Toronto', 'North York', 'Etobicoke']);
    // Naming one key must not drag the others along.
    expect(merged.notify.minScore).toBe(72);
  });

  it('adds the new field while writing nothing else', () => {
    const stored = storedBeforeAreas();
    const merged = applyPlan(stored, planProfileSync(code, stored));
    expect(merged.hard.excludeAreas).toEqual(['Scarborough', 'East York', 'Brampton']);
    expect(merged.hard.cities).toEqual(stored.hard.cities);
    expect(merged.soft).toEqual(stored.soft);
  });

  it('keeps a key that exists only in the database', () => {
    // Something added by hand, or a field since removed from code: not this tool's business.
    const stored = storedBeforeAreas();
    const withExtra = { ...stored, hard: { ...stored.hard, handTuned: 'keep me' } } as ProfileColumns;
    const merged = applyPlan(withExtra, planProfileSync(code, withExtra));
    expect((merged.hard as unknown as Record<string, unknown>).handTuned).toBe('keep me');
  });

  it('reports nothing to do once the row matches the code', () => {
    const plan = planProfileSync(code, code);
    expect(plan.additions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe('sameValue', () => {
  it('ignores key order but not array order', () => {
    expect(sameValue({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('does not confuse a missing key with an undefined one', () => {
    expect(sameValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});
