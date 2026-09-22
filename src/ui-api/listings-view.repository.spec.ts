import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Database, type DbHandle } from '@/db/client';
import { listings, matches, profiles } from '@/db/schema';
import { ListingsViewRepository } from './listings-view.repository';

/**
 * The UI's reads, against real SQL — the same harness as recheck-queue.spec.ts.
 *
 * Every assertion here is about a join or a filter that TypeScript cannot check: that a dismissed
 * row leaves the default feed, that the other portal counts as a duplicate, that writing a note
 * does not reset a favourite. All of it happens inside a transaction that is rolled back.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const PROFILE = 'test-ui-profile';
const NO_FILTER = { minScore: 0, includeDelisted: false, includeDismissed: false };

class RollbackSignal extends Error {}

interface Ids {
  a: string;
  b: string;
  c: string;
}

describeDb('the UI feed, against real SQL', () => {
  let handle: DbHandle;

  beforeAll(() => {
    handle = createDb(DATABASE_URL!, { max: 1 });
  });

  afterAll(async () => {
    await handle.close();
  });

  /**
   * Seeds three listings — a and b are the same unit on two portals, c is a near-miss — then hands
   * the repository to the test and rolls everything back.
   */
  async function withSeed<T>(fn: (repo: ListingsViewRepository, ids: Ids) => Promise<T>): Promise<T> {
    let result: T | undefined;
    await handle.db
      .transaction(async (tx) => {
        // Cleared inside the transaction, never outside it; listing_states cascades from listings.
        await tx.delete(matches);
        await tx.delete(listings);

        await tx.insert(profiles).values({
          id: PROFILE,
          label: 'ui test',
          active: false,
          hard: {} as never,
          soft: {} as never,
          notify: {} as never,
        });

        const insert = async (source: 'kijiji' | 'zumper', id: string, fingerprint: string, rent: string): Promise<string> => {
          const [row] = await tx
            .insert(listings)
            .values({
              source,
              sourceId: id,
              url: `https://example.test/${id}`,
              fingerprint,
              title: id,
              rawText: `body of ${id}`,
              rentBase: rent,
              totalMonthlyCost: rent,
              beds: 2,
              city: 'Toronto',
            })
            .returning({ id: listings.id });
          return row!.id;
        };
        const ids: Ids = {
          a: await insert('kijiji', 'ui-a', 'fp-shared', '2800'),
          b: await insert('zumper', 'ui-b', 'fp-shared', '2750'),
          c: await insert('kijiji', 'ui-c', 'fp-other', '2400'),
        };
        await tx.insert(matches).values([
          { listingId: ids.a, profileId: PROFILE, score: 70, breakdown: { bedroomFit: 30 } },
          { listingId: ids.b, profileId: PROFILE, score: 68, breakdown: { bedroomFit: 28 } },
          { listingId: ids.c, profileId: PROFILE, score: 40, breakdown: { bedroomFit: 10 } },
        ]);

        result = await fn(new ListingsViewRepository(tx as unknown as Database), ids);
        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });
    return result as T;
  }

  it('leaves the real corpus exactly as it found it', async () => {
    const count = async (): Promise<number> => {
      const [row] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(listings);
      return row?.n ?? 0;
    };
    const before = await count();
    await withSeed(async () => undefined);
    expect(await count()).toBe(before);
  });

  it('hides what scored below the bar and counts the other portal as a duplicate', async () => {
    const { above, all } = await withSeed(async (repo) => ({
      above: await repo.findFeedRows(PROFILE, { ...NO_FILTER, minScore: 65 }),
      all: await repo.findFeedRows(PROFILE, NO_FILTER),
    }));
    expect(above.map((r) => r.listing.sourceId)).toEqual(['ui-a', 'ui-b']);
    expect(above.map((r) => r.duplicates)).toEqual([1, 1]);
    expect(all.map((r) => r.listing.sourceId)).toEqual(['ui-a', 'ui-b', 'ui-c']);
    expect(all[2]?.duplicates).toBe(0);
    // The body is not on the feed: it is the whole advertisement, and a page needs none of it.
    expect(all[0]?.listing).not.toHaveProperty('rawText');
    expect(all[0]?.stateStatus).toBeNull();
  });

  it('hides a dismissed listing by default and shows it when asked', async () => {
    const result = await withSeed(async (repo, ids) => {
      await repo.upsertState(ids.a, PROFILE, { status: 'dismissed' });
      return {
        byDefault: await repo.findFeedRows(PROFILE, NO_FILTER),
        included: await repo.findFeedRows(PROFILE, { ...NO_FILTER, includeDismissed: true }),
        only: await repo.findFeedRows(PROFILE, { ...NO_FILTER, includeDismissed: true, status: 'dismissed' }),
      };
    });
    expect(result.byDefault.map((r) => r.listing.sourceId)).toEqual(['ui-b', 'ui-c']);
    expect(result.included.map((r) => r.listing.sourceId)).toEqual(['ui-a', 'ui-b', 'ui-c']);
    expect(result.included[0]?.stateStatus).toBe('dismissed');
    expect(result.only.map((r) => r.listing.sourceId)).toEqual(['ui-a']);
  });

  it('keeps the status when only the note changes, and the note when only the status does', async () => {
    const rows = await withSeed(async (repo, ids) => {
      const steps = [];
      steps.push(await repo.upsertState(ids.a, PROFILE, { status: 'favourite' }));
      steps.push(await repo.upsertState(ids.a, PROFILE, { note: 'ligar amanhã' }));
      steps.push(await repo.upsertState(ids.a, PROFILE, { status: 'contacted' }));
      steps.push(await repo.upsertState(ids.a, PROFILE, { note: null }));
      return steps;
    });
    expect(rows.map((r) => [r.status, r.note])).toEqual([
      ['favourite', null],
      ['favourite', 'ligar amanhã'],
      ['contacted', 'ligar amanhã'],
      ['contacted', null],
    ]);
  });

  it('counts the header numbers for one profile', async () => {
    const counts = await withSeed(async (repo, ids) => {
      await repo.upsertState(ids.a, PROFILE, { status: 'favourite' });
      await repo.upsertState(ids.c, PROFILE, { status: 'dismissed' });
      return repo.summaryCounts(PROFILE, 65);
    });
    expect(counts).toEqual({
      scored: 3,
      aboveMinScore: 2,
      newSince24h: 3,
      delisted: 0,
      favourites: 1,
      contacted: 0,
      dismissed: 1,
    });
  });

  it('finds the same unit on the other portal, with the score this profile gave it', async () => {
    const siblings = await withSeed(async (repo, ids) => repo.findSiblings('fp-shared', ids.a, PROFILE));
    expect(siblings.map((s) => [s.source, s.score])).toEqual([['zumper', 68]]);
  });

  it('returns the body on the detail, whatever the listing’s state', async () => {
    const detail = await withSeed(async (repo, ids) => {
      await repo.upsertState(ids.a, PROFILE, { status: 'dismissed' });
      return repo.findMatchById(ids.a, PROFILE);
    });
    expect(detail?.listing.rawText).toBe('body of ui-a');
    expect(detail?.stateStatus).toBe('dismissed');
    expect(Number(detail?.score)).toBe(70);
  });

  it('knows which listings a profile never scored', async () => {
    const [mine, theirs, missing] = await withSeed(async (repo, ids) =>
      Promise.all([
        repo.matchExists(ids.c, PROFILE),
        repo.matchExists(ids.c, 'some-other-profile'),
        repo.findMatchById('00000000-0000-0000-0000-000000000000', PROFILE),
      ]),
    );
    expect(mine).toBe(true);
    expect(theirs).toBe(false);
    expect(missing).toBeNull();
  });
});
