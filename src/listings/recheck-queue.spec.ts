import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database, type DbHandle } from '@/db/client';
import { listings, matches, profiles } from '@/db/schema';
import { ListingsRepository, MAX_MISSED_SWEEPS } from './listings.repository';

/**
 * The re-check queue, against real SQL.
 *
 * Every assertion here corresponds to something that was broken in production and reported
 * itself as something else entirely: the Kijiji adapter announcing that Kijiji had changed its
 * page structure, on every single cycle, while what it had actually been handed was a Zumper
 * listing. A TypeScript mirror of the query could not have caught any of it.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const PROFILE = 'test-recheck-profile';

class RollbackSignal extends Error {}

interface Seed {
  id: string;
  source: 'kijiji' | 'zumper';
  lastSeenAt: Date;
  missedSweeps?: number;
  delisted?: boolean;
  /** A listing nobody matched has never been surfaced, so nobody is waiting on its status. */
  matched?: boolean;
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

describeDb('the re-check queue, against real SQL', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(DATABASE_URL!, { max: 1 });
  });

  afterAll(async () => {
    await handle.close();
  });

  /** Seeds listings, asks the queue what to re-check, and rolls the whole thing back. */
  async function queue(
    seeds: Seed[],
    opts: { source?: string; limit?: number; failFirst?: boolean } = {},
  ): Promise<{ ids: string[]; missedAfterFailure?: number }> {
    let result: { ids: string[]; missedAfterFailure?: number } = { ids: [] };

    await handle.db
      .transaction(async (tx) => {
        // Cleared inside the transaction, never outside it. The queue's whole behaviour is
        // relative — which listing comes first, which is excluded — so it cannot be asserted
        // against a table that also holds a real corpus. The rollback is what makes this safe,
        // and the first test below proves the corpus survives it.
        await tx.delete(matches);
        await tx.delete(listings);

        await tx.insert(profiles).values({
          id: PROFILE,
          label: 'recheck test',
          active: false,
          hard: {} as never,
          soft: {} as never,
          notify: {} as never,
        });

        for (const s of seeds) {
          const [row] = await tx
            .insert(listings)
            .values({
              source: s.source,
              sourceId: s.id,
              url: `https://example.test/${s.id}`,
              fingerprint: `fp-${s.id}`,
              title: s.id,
              rentBase: '2000',
              totalMonthlyCost: '2000',
              lastSeenAt: s.lastSeenAt,
              missedSweeps: s.missedSweeps ?? 0,
              delistedAt: s.delisted ? new Date() : null,
            })
            .returning({ id: listings.id });

          if (s.matched !== false) {
            await tx.insert(matches).values({
              listingId: row!.id,
              profileId: PROFILE,
              score: 70,
              breakdown: {},
            });
          }
        }

        const repo = new ListingsRepository(tx as unknown as Database);
        const rows = await repo.findForRecheck(opts.source ?? 'kijiji', opts.limit ?? 10);
        result.ids = rows.map((r) => r.sourceId);

        if (opts.failFirst && rows[0]) {
          result.missedAfterFailure = await repo.markRecheckFailed(rows[0].id);
        }

        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });

    return result;
  }

  it('leaves the real corpus exactly as it found it', async () => {
    // This harness empties `listings` inside its transaction, so proving the rollback is not a
    // formality — it is the only thing standing between a test run and the collected corpus.
    const count = async (): Promise<number> => {
      const [row] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(listings);
      return row?.n ?? 0;
    };
    const before = await count();
    await queue([{ id: 'trace', source: 'kijiji', lastSeenAt: daysAgo(1) }]);
    expect(await count()).toBe(before);

    const [row] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(listings)
      .where(sql`${listings.sourceId} = 'trace'`);
    expect(row?.n).toBe(0);
  });

  it('never hands one source another source’s listing', async () => {
    // The production failure, exactly: a Zumper listing fetched by the Kijiji adapter, from
    // zumper.com, through Kijiji's rate limiter, then parsed for a __NEXT_DATA__ block Zumper
    // has never had — and reported as "the page structure changed".
    const { ids } = await queue([
      { id: 'kijiji-one', source: 'kijiji', lastSeenAt: daysAgo(2) },
      { id: 'zumper-one', source: 'zumper', lastSeenAt: daysAgo(9) },
    ]);
    expect(ids).toEqual(['kijiji-one']);
  });

  it('returns the least recently confirmed first', async () => {
    // What the doc comment always claimed and the query never did: DISTINCT ON (id) forced
    // Postgres to sort by a random-but-stable uuid, so the same rows came back every cycle and
    // updating last_seen_at changed nothing.
    const { ids } = await queue([
      { id: 'seen-yesterday', source: 'kijiji', lastSeenAt: daysAgo(1) },
      { id: 'seen-last-week', source: 'kijiji', lastSeenAt: daysAgo(7) },
      { id: 'seen-last-month', source: 'kijiji', lastSeenAt: daysAgo(30) },
    ]);
    expect(ids).toEqual(['seen-last-month', 'seen-last-week', 'seen-yesterday']);
  });

  it('returns each listing once even when several profiles matched it', async () => {
    // What DISTINCT ON was there for. EXISTS states the requirement without duplicating rows.
    let ids: string[] = [];
    await handle.db
      .transaction(async (tx) => {
        await tx.delete(matches);
        await tx.delete(listings);
        for (const id of ['p1', 'p2']) {
          await tx.insert(profiles).values({
            id, label: id, active: false, hard: {} as never, soft: {} as never, notify: {} as never,
          });
        }
        const [row] = await tx
          .insert(listings)
          .values({
            source: 'kijiji', sourceId: 'popular', url: 'https://example.test/popular',
            fingerprint: 'fp', title: 'popular', rentBase: '2000', totalMonthlyCost: '2000',
            lastSeenAt: daysAgo(3),
          })
          .returning({ id: listings.id });
        for (const id of ['p1', 'p2']) {
          await tx.insert(matches).values({ listingId: row!.id, profileId: id, score: 70, breakdown: {} });
        }
        const repo = new ListingsRepository(tx as unknown as Database);
        ids = (await repo.findForRecheck('kijiji', 10)).map((r) => r.sourceId);
        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });
    expect(ids).toEqual(['popular']);
  });

  it('ignores listings nobody matched, and ones already known gone', async () => {
    const { ids } = await queue([
      { id: 'never-surfaced', source: 'kijiji', lastSeenAt: daysAgo(40), matched: false },
      { id: 'already-gone', source: 'kijiji', lastSeenAt: daysAgo(40), delisted: true },
      { id: 'live', source: 'kijiji', lastSeenAt: daysAgo(1) },
    ]);
    expect(ids).toEqual(['live']);
  });

  it('drops a listing that has failed too many times, without calling it delisted', async () => {
    // One unreadable advertisement was consuming a request every cycle and failing the run with
    // it. It leaves the queue; it is never presumed gone, because being unable to read an ad is
    // not evidence about the ad.
    const { ids } = await queue([
      { id: 'unreadable', source: 'kijiji', lastSeenAt: daysAgo(30), missedSweeps: MAX_MISSED_SWEEPS },
      { id: 'fine', source: 'kijiji', lastSeenAt: daysAgo(2) },
    ]);
    expect(ids).toEqual(['fine']);
  });

  it('counts a failure against the listing rather than leaving it untouched', async () => {
    const { missedAfterFailure } = await queue(
      [{ id: 'flaky', source: 'kijiji', lastSeenAt: daysAgo(5), missedSweeps: 1 }],
      { failFirst: true },
    );
    expect(missedAfterFailure).toBe(2);
  });

  it('honours the budget', async () => {
    const { ids } = await queue(
      [1, 2, 3, 4].map((n) => ({ id: `b${n}`, source: 'kijiji' as const, lastSeenAt: daysAgo(n) })),
      { limit: 2 },
    );
    expect(ids).toEqual(['b4', 'b3']);
  });
});
