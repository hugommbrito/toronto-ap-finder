import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL,
  OPT_IN,
  PRESERVED,
  planReset,
  schemaTableNames,
  schemaTables,
} from './reset-operational';

const ALL = schemaTableNames();

describe('schemaTableNames', () => {
  it('reads the tables from the schema rather than a restated list', () => {
    // Restating them is how the list goes stale; this has to come from the schema itself.
    expect(ALL).toContain('listings');
    expect(ALL).toContain('daycares');
    expect(ALL).toContain('source_buildings');
    expect(ALL.length).toBeGreaterThanOrEqual(14);
  });

  it('hands back the schema table objects, so no name is ever interpolated into SQL', () => {
    // The statement is built from the schema's own objects; a name that is not in the schema
    // cannot become part of one.
    const tables = schemaTables();
    for (const name of ALL) expect(tables.get(name)).toBeDefined();
    expect(tables.size).toBe(ALL.length);
  });
});

describe('planReset', () => {
  it('accounts for every table the schema declares', () => {
    // The guard the script exists for. When this fails, a table was added and nobody decided
    // whether it survives a reset — which is exactly when the wrong answer is silent.
    expect(() => planReset(ALL, [])).not.toThrow();
  });

  it('refuses to run against a table it does not know about', () => {
    expect(() => planReset([...ALL, 'tenant_payments'], ['--apply'])).toThrow(/unclassified/);
    expect(() => planReset([...ALL, 'tenant_payments'], ['--apply'])).toThrow(/tenant_payments/);
  });

  it('never empties a preserved table, whatever flags are passed', () => {
    const plan = planReset(ALL, ['--apply', '--include-buildings', '--include-policy', '--force']);
    for (const table of PRESERVED) expect(plan.truncate).not.toContain(table);
    // Geography and the tuned profile are the two things a reset must never cost.
    expect(plan.preserved).toContain('daycares');
    expect(plan.preserved).toContain('profiles');
    expect(plan.preserved).toContain('geocode_cache');
  });

  it('empties the operational tables by default', () => {
    const plan = planReset(ALL, []);
    for (const table of OPERATIONAL) expect(plan.truncate).toContain(table);
  });

  it('leaves the costly ones alone until they are named', () => {
    const plan = planReset(ALL, ['--apply']);
    // Clearing source_buildings re-opens 229 buildings; source_policy un-pauses a 429.
    for (const table of Object.keys(OPT_IN)) {
      expect(plan.truncate).not.toContain(table);
      expect(plan.skipped.map((s) => s.table)).toContain(table);
    }
  });

  it('includes an opt-in table when its own flag is given, and only then', () => {
    const buildings = planReset(ALL, ['--apply', '--include-buildings']);
    expect(buildings.truncate).toContain('source_buildings');
    expect(buildings.truncate).not.toContain('source_policy');

    const policy = planReset(ALL, ['--apply', '--include-policy']);
    expect(policy.truncate).toContain('source_policy');
    expect(policy.truncate).not.toContain('source_buildings');
  });

  it('reports the flag needed for each table it skipped', () => {
    const plan = planReset(ALL, []);
    for (const { table, flag } of plan.skipped) expect(flag).toBe(OPT_IN[table]);
  });

  it('plans nothing for a table the schema does not have', () => {
    // A database migrated only part-way must not produce a statement naming a missing table.
    const plan = planReset(['listings', 'profiles'], ['--apply', '--include-buildings']);
    expect(plan.truncate).toEqual(['listings']);
    expect(plan.preserved).toEqual(['profiles']);
    expect(plan.skipped).toEqual([]);
  });

  it('keeps the three buckets disjoint', () => {
    const seen = [...OPERATIONAL, ...PRESERVED, ...Object.keys(OPT_IN)];
    expect(new Set(seen).size).toBe(seen.length);
  });
});
