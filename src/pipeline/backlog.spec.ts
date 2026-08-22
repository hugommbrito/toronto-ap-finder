import { describe, expect, it, vi } from 'vitest';
import { PipelineService } from './pipeline.service';
import type { TenantProfile } from '@/profiles/profile.schema';
import type { ListingRow } from '@/db/schema';

/**
 * The failure this covers, from a real day in production: a Zumper unit was first seen at
 * 06:30 — inside quiet hours — scored 66.3, and suppressed. Suppression claims nothing on
 * purpose, so that the next cycle can deliver it. But a building source only re-examines a
 * unit when its building's watermark moves, so no later cycle ever looked at it again and the
 * best-scoring listing of the day was never sent.
 */
const PROFILE: TenantProfile = {
  id: 'sister',
  label: 'test',
  active: true,
  hard: {
    totalRentMax: 3200,
    totalRentMin: 1500,
    bedroomRule: { kind: 'min', beds: 2 },
    availableFrom: null,
    requireParking: false,
    minDaycaresWithin: null,
    allowSplitDwelling: false,
    maxTransitWalkM: null,
    cities: ['Toronto'],
    excludeAreas: [],
  },
  soft: { targetRent: 2600, weights: { rentBelowTarget: 100 } },
  notify: { telegramChatIds: ['chat-1'], minScore: 65, includeMap: false },
};

function row(over: Partial<ListingRow> = {}): ListingRow {
  return {
    id: 'listing-1',
    source: 'zumper',
    sourceId: '61904159',
    url: 'https://example.test/66-broadway',
    fingerprint: 'fp-broadway-2450',
    title: '66 Broadway Avenue Toronto — 2 Bed',
    rawText: null,
    rentBase: '2450',
    parkingIncluded: true,
    parkingCost: null,
    utilitiesIncluded: [],
    totalMonthlyCost: '2450',
    beds: 2,
    dens: 0,
    baths: '1',
    hasLocker: null,
    inSuiteLaundry: null,
    address: '66 Broadway Ave',
    city: 'Toronto',
    lat: 43.7,
    lng: -79.4,
    availableFrom: null,
    buildingBuiltBefore2018: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    hydratedAt: new Date(),
    delistedAt: null,
    missedSweeps: 0,
    postedAt: null,
    rentsafeRsn: null,
    rentsafeMatch: null,
    ...over,
  } as ListingRow;
}

function harness(opts: { pending: Array<{ listing: ListingRow; score: number }>; quietHours?: [number, number] }) {
  const send = vi.fn(async () => ({ messageId: 'msg-1' }));
  const findUnnotifiedMatches = vi.fn(async () => opts.pending);

  const profile: TenantProfile = opts.quietHours
    ? { ...PROFILE, notify: { ...PROFILE.notify, quietHours: opts.quietHours } }
    : PROFILE;

  const service = new PipelineService(
    { findActive: async () => [profile] } as never,
    {
      get: () => ({
        daycaresWithin: () => [],
        nearestStation: () => null,
        stationsWithin: () => [],
        stations: [],
      }),
    } as never,
    {
      findUnnotifiedMatches,
      findVerification: async () => null,
      recordVerification: async () => {},
      upsertMatch: async () => {},
    } as never,
    { send } as never,
    { configured: false } as never,
    { buildingSources: () => [], unitSources: () => [], all: () => [], health: () => ({}), pausedSources: () => [] } as never,
    { get: () => ({ match: () => null }) } as never,
  );

  return { service, send, findUnnotifiedMatches };
}

describe('backlog drain', () => {
  it('sends a match that quiet hours deferred and no sweep saw again', async () => {
    const { service, send } = harness({ pending: [{ listing: row(), score: 66.3 }] });

    const report = await service.runBuildingCycle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(report.notifiedFromBacklog).toBe(1);
    expect(report.notified).toBe(1);
  });

  it('stays quiet while still inside quiet hours', async () => {
    // Draining at 03:00 would defeat the purpose of having a quiet window at all.
    const hour = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(
        new Date(),
      ),
    ) % 24;
    const { service, send } = harness({
      pending: [{ listing: row(), score: 66.3 }],
      quietHours: [hour, (hour + 2) % 24],
    });

    const report = await service.runBuildingCycle();

    expect(send).not.toHaveBeenCalled();
    expect(report.notifiedFromBacklog).toBe(0);
  });

  it('leaves a match below the profile bar alone', async () => {
    const { service, send } = harness({ pending: [{ listing: row(), score: 44.3 }] });

    await service.runBuildingCycle();

    expect(send).not.toHaveBeenCalled();
  });

  it('re-runs the hard filters rather than trusting the stored score', async () => {
    // The stored score cleared the bar, but the unit is in a city the profile refuses. A
    // backlog that replayed scores blindly would deliver it.
    const { service, send } = harness({
      pending: [{ listing: row({ city: 'Vaughan' }), score: 80 }],
    });

    await service.runBuildingCycle();

    expect(send).not.toHaveBeenCalled();
  });

  it('does not send in a dry run', async () => {
    const { service, send, findUnnotifiedMatches } = harness({ pending: [{ listing: row(), score: 66.3 }] });

    await service.runBuildingCycle({ dryRun: true });

    expect(send).not.toHaveBeenCalled();
    expect(findUnnotifiedMatches).not.toHaveBeenCalled();
  });
});
