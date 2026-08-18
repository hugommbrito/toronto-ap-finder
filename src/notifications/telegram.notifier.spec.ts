import { beforeEach, describe, expect, it, vi } from 'vitest';

// Read by loadEnv() when the notifier is constructed inside a test, so setting it here is
// early enough. vi.mock below is hoisted above the imports by vitest.
process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const fetchMock = vi.fn();
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

import { TelegramNotifier } from './telegram.notifier';
import { buildSisterProfile } from '@/seed/sister-profile';
import type { NotificationPayload } from './notification.types';

/** Minimal stand-in for the drizzle handle, recording what the notifier did. */
function fakeDb(claimSucceeds = true) {
  const calls = { claimed: 0, released: 0, recorded: [] as string[][] };
  const db = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            calls.claimed += 1;
            return claimSucceeds ? [{ id: 'n1' }] : [];
          },
        }),
      }),
    }),
    delete: () => ({ where: async () => { calls.released += 1; } }),
    update: () => ({
      set: (v: { telegramMessageIds?: string[] }) => ({
        where: async () => { if (v.telegramMessageIds) calls.recorded.push(v.telegramMessageIds); },
      }),
    }),
  };
  return { db, calls };
}

const ok = (id: number) => ({ json: async () => ({ ok: true, result: { message_id: id } }) });
const rejected = (why: string) => ({ json: async () => ({ ok: false, description: why }) });

function payload(chatIds: string[]): NotificationPayload {
  const profile = buildSisterProfile(chatIds);
  return {
    listingId: 'l1',
    fingerprint: 'fp-abcdef123456',
    profileId: profile.id,
    chatIds,
    includeMap: false,
    listing: {
      source: 'kijiji', sourceId: '1', url: 'https://example.com/1', title: 'A unit', rawText: null,
      rentBase: 2400, parkingIncluded: true, parkingCost: null, utilitiesIncluded: [], totalMonthlyCost: 2400,
      beds: 3, dens: 0, baths: 1, hasLocker: null, inSuiteLaundry: null,
      address: '1 Main St', city: 'Toronto', lat: 43.7, lng: -79.4,
      availableFrom: null, postedAt: null, buildingBuiltBefore2018: null,
    },
    score: { score: 80, breakdown: { bedroomFit: 25 }, rawComponents: {}, skipped: [] },
    reachableLines: [], transitRadiusM: 1200,
    daycaresNearby: { total: 1, cwelcc: 1, radiusM: 800 }, nearestDaycare: null,
    unverified: [],
  };
}

beforeEach(() => fetchMock.mockReset());

describe('TelegramNotifier — several recipients', () => {
  it('sends one message per recipient and records every id', async () => {
    fetchMock.mockResolvedValueOnce(ok(11)).mockResolvedValueOnce(ok(12)).mockResolvedValueOnce(ok(13));
    const { db, calls } = fakeDb();
    const notifier = new TelegramNotifier(db as never);

    const result = await notifier.send(payload(['a', 'b', 'c']));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.messageId).toBe('11');
    expect(calls.recorded).toEqual([['11', '12', '13']]);
    expect(calls.released).toBe(0);
  });

  /**
   * The rule that matters. Releasing the claim after a partial delivery would re-send the
   * listing to everyone next cycle — including the people who already read it. A duplicate
   * for three people is worse than a gap for one.
   */
  it('keeps the claim when only some recipients fail', async () => {
    fetchMock.mockResolvedValueOnce(ok(21)).mockResolvedValueOnce(rejected('chat not found'));
    const { db, calls } = fakeDb();
    const notifier = new TelegramNotifier(db as never);

    const result = await notifier.send(payload(['good', 'bad']));

    expect(result.messageId).toBe('21');
    expect(calls.released).toBe(0);
    expect(calls.recorded).toEqual([['21']]);
  });

  it('releases the claim only when nobody was reached', async () => {
    fetchMock.mockResolvedValueOnce(rejected('boom')).mockResolvedValueOnce(rejected('boom'));
    const { db, calls } = fakeDb();
    const notifier = new TelegramNotifier(db as never);

    const result = await notifier.send(payload(['x', 'y']));

    expect(result.messageId).toBeNull();
    // Released, so a transient outage does not silence the listing forever.
    expect(calls.released).toBe(1);
    expect(calls.recorded).toEqual([]);
  });

  it('sends nothing when the unit was already notified for this profile', async () => {
    const { db, calls } = fakeDb(false);
    const notifier = new TelegramNotifier(db as never);

    const result = await notifier.send(payload(['a', 'b']));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.messageId).toBeNull();
    expect(calls.released).toBe(0);
  });

  it('sends a pin per recipient when the profile asks for one', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(31)).mockResolvedValueOnce(ok(0))
      .mockResolvedValueOnce(ok(32)).mockResolvedValueOnce(ok(0));
    const { db } = fakeDb();
    const notifier = new TelegramNotifier(db as never);

    await notifier.send({ ...payload(['a', 'b']), includeMap: true });

    // two messages + two pins
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith('/sendMessage'))).toHaveLength(2);
    expect(urls.filter((u) => u.endsWith('/sendVenue'))).toHaveLength(2);
  });
});
