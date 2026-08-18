import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database, type DbHandle } from '@/db/client';
import { sourceBuildings } from '@/db/schema';
import { ListingsRepository } from './listings.repository';

/**
 * The one place in this repository that talks to Postgres.
 *
 * Every other spec is a pure function over a fixture, which is the right default — but the whole
 * of this bug lived in a SQL `WHERE` clause and an `ORDER BY`, and neither can be tested by
 * mirroring them in TypeScript: a mirror that drifts from the query is exactly the failure being
 * guarded against. So this runs the real statements.
 *
 * Written like `pnpm verify`: everything happens inside a transaction that always rolls back, so
 * the suite leaves no trace in a database that holds a real corpus. Skipped when there is no
 * DATABASE_URL, so `pnpm test` still runs anywhere.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

/** Isolates this spec from the 112 real Zumper rows sharing the table. */
const SOURCE = 'test_expansion_source';
const TTL_MS = 24 * 60 * 60 * 1_000;

class RollbackSignal extends Error {}

interface Building {
  id: string;
  lastExpandedAt: Date | null;
  modifiedOn: Date | null;
  expandedModifiedOn: Date | null;
}

const hoursAgo = (n: number): Date => new Date(Date.now() - n * 3_600_000);

describeDb('building expansion, against real SQL', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(DATABASE_URL!, { max: 1 });
  });

  afterAll(async () => {
    await handle.close();
  });

  /**
   * Seeds the given buildings, asks which are due, and rolls back whatever happened.
   * Returns the ids in the order the query chose, because the order is half the fix.
   */
  async function due(buildings: Building[], limit = 50): Promise<{ ids: string[]; backlog: number }> {
    let result: { ids: string[]; backlog: number } = { ids: [], backlog: 0 };

    await handle.db
      .transaction(async (tx) => {
        await tx.insert(sourceBuildings).values(
          buildings.map((b) => ({
            source: SOURCE,
            sourceId: b.id,
            url: `https://example.test/${b.id}`,
            lastExpandedAt: b.lastExpandedAt,
            modifiedOn: b.modifiedOn,
            expandedModifiedOn: b.expandedModifiedOn,
          })),
        );

        const repo = new ListingsRepository(tx as unknown as Database);
        const rows = await repo.findBuildingsDueForExpansion(SOURCE, limit, TTL_MS);
        result = {
          ids: rows.map((r) => r.sourceId),
          backlog: await repo.countBuildingsDueForExpansion(SOURCE, TTL_MS),
        };

        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });

    return result;
  }

  it('leaves no trace: the transaction really does roll back', async () => {
    await due([{ id: 'trace', lastExpandedAt: null, modifiedOn: null, expandedModifiedOn: null }]);
    const [row] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(sourceBuildings)
      .where(sql`${sourceBuildings.source} = ${SOURCE}`);
    expect(row?.n).toBe(0);
  });

  it('selects a building nobody has ever opened', async () => {
    const { ids, backlog } = await due([
      { id: 'fresh', lastExpandedAt: null, modifiedOn: null, expandedModifiedOn: null },
    ]);
    expect(ids).toEqual(['fresh']);
    expect(backlog).toBe(1);
  });

  it('does NOT re-select a watermark-less building that was just opened', async () => {
    // The regression. Before the fix, `expanded_modified_on IS NULL` kept this due forever,
    // because markBuildingExpanded copies a null modified_on straight back into it.
    const { ids, backlog } = await due([
      { id: 'just-opened', lastExpandedAt: hoursAgo(1), modifiedOn: null, expandedModifiedOn: null },
    ]);
    expect(ids).toEqual([]);
    expect(backlog).toBe(0);
  });

  it('selects a watermark-less building once it has aged past the TTL', async () => {
    const { ids } = await due([
      { id: 'stale', lastExpandedAt: hoursAgo(25), modifiedOn: null, expandedModifiedOn: null },
      { id: 'recent', lastExpandedAt: hoursAgo(2), modifiedOn: null, expandedModifiedOn: null },
    ]);
    expect(ids).toEqual(['stale']);
  });

  it('selects a building whose source says it changed, and skips one that has not', async () => {
    // Zumper's normal path, and it must keep working exactly as before.
    const { ids } = await due([
      { id: 'changed', lastExpandedAt: hoursAgo(2), modifiedOn: hoursAgo(1), expandedModifiedOn: hoursAgo(3) },
      { id: 'unchanged', lastExpandedAt: hoursAgo(2), modifiedOn: hoursAgo(3), expandedModifiedOn: hoursAgo(3) },
    ]);
    expect(ids).toEqual(['changed']);
  });

  it('puts never-opened buildings ahead of ones already seen', async () => {
    // The other half of the bug: ORDER BY last_expanded_at puts nulls LAST in Postgres, so
    // already-opened buildings outranked never-opened ones and the rest of the inventory was
    // never reached — while the cycle log printed a healthy count of buildings opened.
    const { ids } = await due([
      { id: 'seen-recently', lastExpandedAt: hoursAgo(30), modifiedOn: null, expandedModifiedOn: null },
      { id: 'never-opened', lastExpandedAt: null, modifiedOn: null, expandedModifiedOn: null },
      { id: 'seen-long-ago', lastExpandedAt: hoursAgo(200), modifiedOn: null, expandedModifiedOn: null },
    ]);
    expect(ids).toEqual(['never-opened', 'seen-long-ago', 'seen-recently']);
  });

  it('reports a backlog larger than the page of work taken', async () => {
    // Counted rather than inferred: a backlog of 3 reported as "1 deferred" is how a backfill
    // that will never finish looks finished.
    const buildings = [1, 2, 3, 4].map((n) => ({
      id: `b${n}`,
      lastExpandedAt: null,
      modifiedOn: null,
      expandedModifiedOn: null,
    }));
    const { ids, backlog } = await due(buildings, 2);
    expect(ids).toHaveLength(2);
    expect(backlog).toBe(4);
  });

  it('honours the TTL it is given rather than a hardcoded one', async () => {
    const rows = [{ id: 'aged', lastExpandedAt: hoursAgo(25), modifiedOn: null, expandedModifiedOn: null }];
    expect((await due(rows)).ids).toEqual(['aged']);

    // Same row, a week-long TTL: not due. This is the Zumper backstop's setting.
    let ids: string[] = [];
    await handle.db
      .transaction(async (tx) => {
        await tx.insert(sourceBuildings).values({
          source: SOURCE,
          sourceId: 'aged',
          url: 'https://example.test/aged',
          lastExpandedAt: hoursAgo(25),
        });
        const repo = new ListingsRepository(tx as unknown as Database);
        ids = (await repo.findBuildingsDueForExpansion(SOURCE, 50, 7 * 24 * 3_600_000)).map((r) => r.sourceId);
        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });
    expect(ids).toEqual([]);
  });
});
