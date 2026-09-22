import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListingVerificationRow, RentSafeBuildingRow } from '@/db/schema';
import { areaContaining } from '@/geo/areas';
import { canonicalMunicipality } from '@/geo/city';
import { geoContextFor, mapPointsFor, transitRadiusOf } from '@/geo/geo-context';
import { GeoService } from '@/geo/geo.service';
import { listingFromRow, type TriageListing } from '@/listings/listing.types';
import { ListingsRepository } from '@/listings/listings.repository';
import { OperationsService, type OperationsReport } from '@/operations/operations.service';
import { PipelineService } from '@/pipeline/pipeline.service';
import type { BedroomTier, TenantProfile } from '@/profiles/profile.schema';
import { ProfilesService } from '@/profiles/profiles.service';
import { evaluateBedroomRule, type UnitLayout } from '@/scoring/bedroom-rule';
import type {
  FeedItem,
  FeedPage,
  ListingCore,
  ListingDetail,
  ListingState,
  ProfileSummary,
  RentSafeFull,
  Sibling,
  SortKey,
  StateUpdate,
  Summary,
  VerificationView,
} from './api-types';
import type { FeedQuery } from './feed-query';
import {
  ListingsViewRepository,
  type FeedRow,
  type ListingColumnsRow,
  type SiblingRow,
} from './listings-view.repository';

/**
 * Assembles what the browser shows from what the pipeline stored.
 *
 * Two things are computed here rather than read, because nothing persists them: the area a
 * listing falls in (`areaContaining`, from the 1998 boundaries) and which bedroom tier it sits on.
 * Both are cheap, and computing them means a boundary or profile change corrects every listing
 * at once rather than only the ones scored afterwards.
 */
@Injectable()
export class ListingsViewService {
  constructor(
    private readonly views: ListingsViewRepository,
    private readonly repo: ListingsRepository,
    private readonly profilesService: ProfilesService,
    private readonly geoService: GeoService,
    private readonly pipeline: PipelineService,
    private readonly operations: OperationsService,
  ) {}

  async profiles(): Promise<ProfileSummary[]> {
    const active = await this.profilesService.findActive();
    return active.map(profileSummary);
  }

  /**
   * SQL narrows by what it can index — profile, score, rent, delisted, dismissed — and the rest
   * happens in memory: area and tier are derived, not stored, so they cannot be predicates; facets
   * have to be counted over the un-narrowed set or the chips only ever show what is already
   * selected; and offset paging over a few hundred rows costs nothing.
   */
  async feed(q: FeedQuery): Promise<FeedPage> {
    const profile = await this.loadProfile(q.profile);
    const minScore = q.minScore ?? profile.notify.minScore;
    // Asking for the dismissed ones is asking to see them.
    const includeDismissed = q.includeDismissed || q.status === 'dismissed';

    const rows = await this.views.findFeedRows(profile.id, {
      minScore,
      maxRent: q.maxRent,
      includeDelisted: q.includeDelisted,
      includeDismissed,
      status: q.status,
    });
    const items = rows.map((row) => toFeedItem(row, profile));
    const facets = facetsOf(items);
    const narrowed = sortItems(
      applyFilters(items, { tier: q.tier, city: q.city, area: q.area, sources: q.source }),
      q.sort,
    );
    const start = (q.page - 1) * q.limit;

    return {
      items: narrowed.slice(start, start + q.limit),
      total: narrowed.length,
      page: q.page,
      limit: q.limit,
      applied: { minScore, sort: q.sort, includeDelisted: q.includeDelisted, includeDismissed },
      facets,
    };
  }

  async detail(listingId: string, profileId: string): Promise<ListingDetail> {
    const profile = await this.loadProfile(profileId);
    const row = await this.views.findMatchById(listingId, profile.id);
    if (!row) throw new NotFoundException(`no scored listing ${listingId} for profile "${profile.id}"`);

    const [verification, building, siblings, reviews] = await Promise.all([
      this.repo.findVerification(listingId),
      row.rentsafeRsn ? this.views.findRentSafe(row.rentsafeRsn) : Promise.resolve(null),
      this.views.findSiblings(row.listing.fingerprint, listingId, profile.id),
      this.views.findOpenReviews(listingId, profile.id),
    ]);

    const triage = listingFromRow(row.listing);
    const geo = this.geoService.get();
    const located = triage.lat !== null && triage.lng !== null;

    return {
      ...toFeedItem(row, profile),
      rawText: row.listing.rawText,
      verification: verification ? toVerificationView(verification) : null,
      rentsafeFull: building ? toRentSafeFull(building, row.listing.rentsafeMatch) : null,
      geo: located ? geoContextFor(triage, profile, geo) : null,
      map: mapPointsFor(triage, profile, geo),
      siblings: siblings.map(toSibling),
      skipped: skippedComponents(profile.soft.weights, row.breakdown),
      unverified: reviews,
    };
  }

  async summary(profileId: string): Promise<Summary> {
    const profile = await this.loadProfile(profileId);
    const [lastCycleAt, counts] = await Promise.all([
      // From the database, not `pipeline.status`: the in-memory value resets on every redeploy.
      this.repo.lastCycleFinishedAt(),
      this.views.summaryCounts(profile.id, profile.notify.minScore),
    ]);
    return {
      lastCycleAt: lastCycleAt?.toISOString() ?? null,
      minutesSinceLastCycle: lastCycleAt ? Math.round((Date.now() - lastCycleAt.getTime()) / 60_000) : null,
      pausedSources: this.pipeline.status.pausedSources,
      counts,
    };
  }

  async updateState(listingId: string, profileId: string, patch: StateUpdate): Promise<ListingState> {
    const profile = await this.loadProfile(profileId);
    // Checked first, so a listing this profile never scored is a 404 and not a foreign-key error.
    if (!(await this.views.matchExists(listingId, profile.id))) {
      throw new NotFoundException(`no scored listing ${listingId} for profile "${profile.id}"`);
    }
    const row = await this.views.upsertState(listingId, profile.id, patch);
    return { status: row.status, note: row.note, updatedAt: row.updatedAt.toISOString() };
  }

  funnel(hours: number): Promise<OperationsReport> {
    return this.operations.report(hours);
  }

  private async loadProfile(id: string): Promise<TenantProfile> {
    const profile = await this.profilesService.findById(id);
    if (!profile || !profile.active) throw new NotFoundException(`profile "${id}" not found or inactive`);
    return profile;
  }
}

// ---- pure helpers, exported for tests ----------------------------------------------------------

export function profileSummary(p: TenantProfile): ProfileSummary {
  const daycare = p.hard.minDaycaresWithin;
  return {
    id: p.id,
    label: p.label,
    minScore: p.notify.minScore,
    weights: p.soft.weights,
    bedroomTiers: (p.soft.bedroomTiers ?? []).map((t) => ({ label: t.label, value: t.value })),
    cities: p.hard.cities,
    excludeAreas: p.hard.excludeAreas,
    targetRent: p.soft.targetRent ?? null,
    totalRentMax: p.hard.totalRentMax,
    daycare: daycare ? { radiusM: daycare.radiusM, count: daycare.count, ageGroup: daycare.ageGroup } : null,
    transitRadiusM: transitRadiusOf(p),
  };
}

/** First tier whose rule the layout satisfies — the same "first match wins" the scorer applies. */
export function tierOf(tiers: BedroomTier[] | undefined, layout: UnitLayout): { index: number; label: string } | null {
  if (!tiers) return null;
  for (const [index, tier] of tiers.entries()) {
    if (evaluateBedroomRule(tier.rule, layout) === true) return { index, label: tier.label };
  }
  return null;
}

/**
 * Components that returned null and left the denominator. `rawComponents` and `skipped` are
 * computed by the scorer but never stored, so this is inferred: a weighted component with no
 * key in the breakdown is one that could not be evaluated.
 */
export function skippedComponents(weights: Record<string, number>, breakdown: Record<string, number>): string[] {
  return Object.entries(weights)
    .filter(([name, weight]) => weight > 0 && !(name in breakdown))
    .map(([name]) => name);
}

export interface NarrowFilter {
  tier?: number;
  city?: string;
  area?: string;
  sources?: string[];
}

export function applyFilters(items: FeedItem[], f: NarrowFilter): FeedItem[] {
  const city = f.city ? canonicalMunicipality(f.city) : null;
  const sources = f.sources && f.sources.length > 0 ? new Set(f.sources) : null;
  return items.filter(
    (it) =>
      (f.tier === undefined || it.tier?.index === f.tier) &&
      (city === null || canonicalMunicipality(it.listing.city) === city) &&
      (f.area === undefined || it.area === f.area) &&
      (sources === null || sources.has(it.listing.source)),
  );
}

export function facetsOf(items: FeedItem[]): FeedPage['facets'] {
  return {
    sources: tally(items.map((it) => it.listing.source)),
    cities: tally(items.map((it) => canonicalMunicipality(it.listing.city) || null)),
    areas: tally(items.map((it) => it.area)),
  };
}

function tally(values: Array<string | null>): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

type Comparator = (a: FeedItem, b: FeedItem) => number;

const byScoreDesc: Comparator = (a, b) => b.score - a.score;

/** Missing values go last whichever way the sort runs; ties fall back to the score. */
function nullsLast<T>(key: (it: FeedItem) => T | null, cmp: (a: T, b: T) => number): Comparator {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb === null) return byScoreDesc(a, b);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return cmp(ka, kb) || byScoreDesc(a, b);
  };
}

/** ISO-8601 in UTC sorts lexicographically, so string comparison is date comparison. */
const newestFirst = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

export const SORTS: Record<SortKey, Comparator> = {
  score: byScoreDesc,
  rent: (a, b) => a.listing.totalMonthlyCost - b.listing.totalMonthlyCost || byScoreDesc(a, b),
  newest: (a, b) => newestFirst(a.listing.firstSeenAt, b.listing.firstSeenAt) || byScoreDesc(a, b),
  posted: nullsLast((it) => it.listing.postedAt, newestFirst),
  area: nullsLast(
    (it) => it.listing.areaSqft,
    (a, b) => b - a,
  ),
};

export function sortItems(items: FeedItem[], sort: SortKey): FeedItem[] {
  return [...items].sort(SORTS[sort]);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toFeedItem(row: FeedRow, profile: TenantProfile): FeedItem {
  const triage = listingFromRow({ ...row.listing, rawText: null });
  const point = triage.lat !== null && triage.lng !== null ? { lat: triage.lat, lng: triage.lng } : null;
  return {
    listing: toListingCore(row.listing, triage),
    score: Number(row.score),
    breakdown: row.breakdown,
    firstScoredAt: row.firstScoredAt.toISOString(),
    state: { status: row.stateStatus ?? 'none', note: row.stateNote ?? null, updatedAt: iso(row.stateUpdatedAt) },
    rentsafe:
      row.rentsafeRsn !== null && row.rentsafeScore !== null
        ? {
            rsn: row.rentsafeRsn,
            score: row.rentsafeScore,
            evaluatedOn: row.rentsafeEvaluatedOn,
            yearBuilt: row.rentsafeYearBuilt,
            matchTier: row.listing.rentsafeMatch,
          }
        : null,
    notifiedAt: iso(row.notifiedAt),
    duplicates: Number(row.duplicates),
    area: point ? areaContaining(point) : null,
    tier: tierOf(profile.soft.bedroomTiers, { beds: triage.beds, dens: triage.dens }),
  };
}

function toListingCore(row: ListingColumnsRow, triage: TriageListing): ListingCore {
  return {
    id: row.id,
    source: triage.source,
    sourceId: triage.sourceId,
    url: triage.url,
    fingerprint: row.fingerprint,
    title: triage.title,
    rentBase: triage.rentBase,
    parkingIncluded: triage.parkingIncluded,
    parkingCost: triage.parkingCost,
    parkingAvailable: triage.parkingAvailable,
    utilitiesIncluded: triage.utilitiesIncluded,
    totalMonthlyCost: triage.totalMonthlyCost,
    beds: triage.beds,
    dens: triage.dens,
    baths: triage.baths,
    areaSqft: triage.areaSqft,
    hasLocker: triage.hasLocker,
    inSuiteLaundry: triage.inSuiteLaundry,
    address: triage.address,
    city: triage.city,
    lat: triage.lat,
    lng: triage.lng,
    postedAt: iso(triage.postedAt),
    availableFrom: triage.availableFrom,
    buildingBuiltBefore2018: triage.buildingBuiltBefore2018,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    hydratedAt: iso(row.hydratedAt),
    delistedAt: iso(row.delistedAt),
  };
}

function toVerificationView(row: ListingVerificationRow): VerificationView {
  return {
    model: row.model,
    bedrooms: row.bedrooms,
    dens: row.dens,
    isEntireUnit: row.isEntireUnit,
    isSplitDwelling: row.isSplitDwelling,
    areaSqft: row.areaSqft,
    parking: row.parking,
    confidence: row.confidence,
    evidence: row.evidence,
    notes: row.notes,
    applied: row.applied,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRentSafeFull(row: RentSafeBuildingRow, matchTier: string | null): RentSafeFull {
  return {
    rsn: row.rsn,
    score: row.score,
    evaluatedOn: row.evaluatedOn,
    yearBuilt: row.yearBuilt,
    matchTier,
    siteAddress: row.siteAddress,
    confirmedStoreys: row.confirmedStoreys,
    confirmedUnits: row.confirmedUnits,
    propertyType: row.propertyType,
    wardName: row.wardName,
    lat: row.lat,
    lng: row.lng,
  };
}

function toSibling(row: SiblingRow): Sibling {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    rentBase: Number(row.rentBase),
    totalMonthlyCost: Number(row.totalMonthlyCost),
    lastSeenAt: row.lastSeenAt.toISOString(),
    delistedAt: iso(row.delistedAt),
    score: row.score === null ? null : Number(row.score),
  };
}
