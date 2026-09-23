import { describe, expect, it, vi } from 'vitest';
import { PipelineService } from './pipeline.service';
import type { TenantProfile } from '@/profiles/profile.schema';
import type { ListingRow } from '@/db/schema';
import type { TriageListing } from '@/listings/listing.types';
import type { ListingDetail, UnitListingSource } from '@/sources/source.interface';

/**
 * What the pipeline does with a detail fetch that says the ad is gone.
 *
 * The rule was applied in one of the two places that fetch details and not the other, and the
 * Kijiji adapter could not say "gone" at all — a removed ad redirects to a search page, which
 * parsed as an unreadable detail page and retired the ad from re-checking after three tries,
 * never delisted. The adapter now reports REMOVED; this pins what happens next.
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

const AD: TriageListing = {
  source: 'kijiji',
  sourceId: '1733830893',
  url: 'https://www.kijiji.ca/v-apartments-condos/city-of-toronto/2-bedroom-den/1733830893',
  title: '2 Bedroom + Den',
  rawText: null,
  rentBase: 2450,
  parkingIncluded: null,
  parkingCost: null,
  parkingAvailable: null,
  utilitiesIncluded: [],
  totalMonthlyCost: 2450,
  beds: 2,
  dens: 1,
  baths: 1,
  areaSqft: null,
  hasLocker: null,
  inSuiteLaundry: null,
  address: '66 Broadway Ave, Toronto, ON',
  city: 'Toronto',
  lat: 43.7,
  lng: -79.4,
  availableFrom: null,
  postedAt: null,
  buildingBuiltBefore2018: null,
};

function row(over: Partial<ListingRow> = {}): ListingRow {
  return {
    id: 'listing-1',
    source: 'kijiji',
    sourceId: AD.sourceId,
    url: AD.url,
    fingerprint: 'fp-broadway-2450',
    title: AD.title,
    rawText: 'Bright 2 bedroom plus den.',
    rentBase: '2450',
    parkingIncluded: null,
    parkingCost: null,
    parkingAvailable: null,
    utilitiesIncluded: [],
    totalMonthlyCost: '2450',
    beds: 2,
    dens: 1,
    baths: '1',
    areaSqft: null,
    hasLocker: null,
    inSuiteLaundry: null,
    address: AD.address,
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

const REMOVED: ListingDetail = { descriptionHtml: '', status: 'REMOVED' };
const ACTIVE: ListingDetail = { descriptionHtml: '<p>Bright 2 bedroom plus den.</p>', status: 'ACTIVE' };

function harness(opts: {
  triage?: TriageListing[];
  toRecheck?: ListingRow[];
  detail: () => Promise<ListingDetail>;
}) {
  const fetchDetail = vi.fn(opts.detail);
  const source: UnitListingSource = {
    name: 'kijiji',
    paused: false,
    stats: { requests: 0, paused: false, reason: null },
    resetIfCooledDown: () => false,
    minIntervalMs: 0,
    searchTargets: [{ key: 'toronto', label: 'Toronto' }],
    fetchTriagePage: async () => ({
      listings: opts.triage ?? [],
      unparsable: [],
      pagination: { offset: 0, limit: 40, totalCount: opts.triage?.length ?? 0 },
    }),
    fetchDetail,
  };

  const repo = {
    findUnnotifiedMatches: vi.fn(async () => []),
    lastVisitedByTarget: vi.fn(async () => new Map()),
    upsertListing: vi.fn(async () => ({ id: 'listing-1', isNew: true })),
    recordRejections: vi.fn(async () => {}),
    recordReviews: vi.fn(async () => {}),
    findHydrated: vi.fn(async () => new Map()),
    markHydrated: vi.fn(async () => {}),
    findForRecheck: vi.fn(async () => opts.toRecheck ?? []),
    markDelisted: vi.fn(async () => {}),
    markStillListed: vi.fn(async () => {}),
    markRecheckFailed: vi.fn(async () => 1),
    recordCycleRun: vi.fn(async () => {}),
    upsertMatch: vi.fn(async () => {}),
    findVerification: vi.fn(async () => null),
    recordVerification: vi.fn(async () => {}),
    linkRentSafe: vi.fn(async () => {}),
  };
  const send = vi.fn(async () => ({ messageId: 'msg-1' }));

  const service = new PipelineService(
    { findActive: async () => [PROFILE] } as never,
    {
      get: () => ({
        daycaresWithin: () => [],
        nearestStation: () => null,
        stationsWithin: () => [],
        stations: [],
      }),
    } as never,
    repo as never,
    { send } as never,
    { configured: false } as never,
    {
      buildingSources: () => [],
      unitSources: () => [source],
      all: () => [source],
      health: () => ({}),
      pausedSources: () => [],
    } as never,
    { get: () => ({ match: () => null }) } as never,
  );

  return { service, repo, send, fetchDetail };
}

describe('re-check', () => {
  it('marks an ad delisted when the source says it is gone', async () => {
    const { service, repo } = harness({ toRecheck: [row()], detail: async () => REMOVED });

    const report = await service.runCycle({ maxPages: 1 });

    expect(repo.markDelisted).toHaveBeenCalledWith('listing-1');
    expect(repo.markStillListed).not.toHaveBeenCalled();
    expect(report.delisted).toBe(1);
    expect(report.rechecked).toBe(1);
  });

  it('confirms an ad that is still live', async () => {
    const { service, repo } = harness({ toRecheck: [row()], detail: async () => ACTIVE });

    await service.runCycle({ maxPages: 1 });

    expect(repo.markStillListed).toHaveBeenCalledWith('listing-1');
    expect(repo.markDelisted).not.toHaveBeenCalled();
  });

  it('counts a page it could not read against the ad, and never calls that delisted', async () => {
    const { service, repo } = harness({
      toRecheck: [row()],
      detail: async () => {
        throw new Error('Kijiji parse failed: detail page contained no RealEstateListing entry');
      },
    });

    const report = await service.runCycle({ maxPages: 1 });

    expect(repo.markRecheckFailed).toHaveBeenCalledWith('listing-1');
    expect(repo.markDelisted).not.toHaveBeenCalled();
    expect(report.delisted).toBe(0);
  });
});

describe('hydration', () => {
  it('marks an ad gone between the search page and its detail fetch, and scores nothing', async () => {
    const { service, repo, send } = harness({ triage: [AD], detail: async () => REMOVED });

    const report = await service.runCycle({ maxPages: 1, recheckBudget: 0 });

    expect(repo.markDelisted).toHaveBeenCalledWith('listing-1');
    expect(repo.upsertMatch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(report.delisted).toBe(1);
    expect(report.hydrated).toBe(0);
  });

  it('hydrates and scores an ad the source still lists', async () => {
    const { service, repo } = harness({ triage: [AD], detail: async () => ACTIVE });

    const report = await service.runCycle({ maxPages: 1, recheckBudget: 0, dryRun: true });

    expect(repo.markDelisted).not.toHaveBeenCalled();
    expect(repo.markHydrated).toHaveBeenCalledWith('listing-1');
    expect(report.hydrated).toBe(1);
  });
});
