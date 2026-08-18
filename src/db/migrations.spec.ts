import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The journal is the migration list; the .sql files are only cargo.
 *
 * `migrate()` reads `meta/_journal.json` and runs what it names — a .sql file the journal does
 * not mention simply never executes. That is not hypothetical: `0006_source_buildings.sql` was
 * committed without its entry, so `source_buildings` was missing from every database created by
 * the migrator, and the Zumper cycle would have failed on its first upsert against a fresh
 * Railway deployment. It went unnoticed because the dev database had the table, created by hand.
 *
 * No database here on purpose. This has to fail in `pnpm test`, on a laptop, before a deploy
 * discovers it.
 */
const MIGRATIONS_DIR = resolve('src/db/migrations');
const SCHEMA_DIR = resolve('src/db/schema');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function journalEntries(): JournalEntry[] {
  const raw = readFileSync(resolve(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8');
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function sqlTags(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

describe('migration journal', () => {
  it('names every .sql file on disk', () => {
    const tagged = new Set(journalEntries().map((e) => e.tag));
    // The failure this test exists for. Reported as the whole list, because a missing entry is
    // usually the newest file and naming it is the fix.
    expect(sqlTags().filter((tag) => !tagged.has(tag))).toEqual([]);
  });

  it('names nothing that is missing from disk', () => {
    const onDisk = new Set(sqlTags());
    // The mirror failure: a deleted or renamed .sql leaves migrate() looking for a file that is
    // not there, which fails at boot rather than at review time.
    expect(journalEntries().map((e) => e.tag).filter((tag) => !onDisk.has(tag))).toEqual([]);
  });

  it('keeps idx contiguous from zero and equal to the filename prefix', () => {
    const entries = journalEntries();
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    // Drizzle orders by idx, so a prefix that disagrees with it means the file applied is not
    // the file the name implies.
    for (const entry of entries) {
      expect(Number(entry.tag.slice(0, 4)), `tag ${entry.tag}`).toBe(entry.idx);
    }
  });

  it('keeps `when` strictly increasing', () => {
    // `when` becomes created_at in drizzle.__drizzle_migrations, and that column is how already
    // applied migrations are recognised. Out of order, a new migration can be treated as done.
    const whens = journalEntries().map((e) => e.when);
    for (let i = 1; i < whens.length; i += 1) {
      expect(whens[i], `entry ${i}`).toBeGreaterThan(whens[i - 1]!);
    }
  });
});

describe('schema and migrations agree', () => {
  it('has SQL for every table declared in the Drizzle schema', () => {
    const sql = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'))
      .join('\n');

    const declared = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...readFileSync(resolve(SCHEMA_DIR, f), 'utf8').matchAll(/pgTable\(\s*'([^']+)'/g)])
      .map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0);
    // The sibling of the missing-journal-entry bug: a table declared in TypeScript and never
    // created in SQL typechecks perfectly and fails on the first query.
    expect(declared.filter((table) => !sql.includes(`"${table}"`))).toEqual([]);
  });
});
