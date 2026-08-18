import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '@/config/env';
import { buildFingerprint } from '@/geo/address';
import { GeoService } from '@/geo/geo.service';
import { enrichFromText, layoutConflictOf } from '@/listings/enrich';
import { listingFromRow, type TriageListing } from '@/listings/listing.types';
import { ListingsRepository } from '@/listings/listings.repository';
import type { ListingVerificationRow } from '@/db/schema';
import { TelegramNotifier } from '@/notifications/telegram.notifier';
import type { TenantProfile } from '@/profiles/profile.schema';
import { ProfilesService } from '@/profiles/profiles.service';
import { applyHardFilters, type HardFilterResult } from '@/scoring/hard-filters';
import { scoreListing } from '@/scoring/scorer';
import { reachableLines, type GeoIndex } from '@/scoring/context';
import { KijijiSource } from '@/sources/kijiji/kijiji.source';
import { SourcePausedError } from '@/sources/rate-limiter';
import { ListingVerifier, VERIFIER_MODEL, verdictSchema, type Verdict } from '@/verification/listing-verifier';
import { applyVerdict } from '@/verification/apply-verdict';
import type { ListingSource } from '@/sources/source.interface';

export interface CycleOptions {
  /** Search-result pages to walk. 5 pages is 200 ads, which comfortably covers 20 minutes. */
  maxPages?: number;
  /**
   * Detail fetches allowed this cycle. Each costs one request at >= 2 s, so this is the
   * knob that keeps a cold-start backfill from turning into a multi-hour crawl. Anything
   * left over is simply picked up next cycle.
   */
  hydrationBudget?: number;
  /**
   * Detail pages spent confirming whether listings we already care about are still live.
   * Small on purpose: it is a background chore competing with finding new places.
   */
  recheckBudget?: number;
  /** Score, log and store, but send nothing. */
  dryRun?: boolean;
  /**
   * Send even inside the profile's quiet hours, for this run only.
   *
   * A per-run override rather than a profile edit: turning quiet hours off in the database
   * to force one delivery means remembering to turn them back on, and a crash in between
   * leaves the tenant being woken up indefinitely.
   */
  ignoreQuietHours?: boolean;
}

export interface CycleReport {
  pagesFetched: number;
  listingsSeen: number;
  unparsable: number;
  storedNew: number;
  rejectedAtTriage: Record<string, number>;
  hydrated: number;
  /** Scored without a detail request because the body was already stored. */
  reusedFromCache: number;
  hydrationDeferred: number;
  rejectedAfterHydration: Record<string, number>;
  needsReview: number;
  verified: number;
  verificationRejected: number;
  verificationCorrected: number;
  rechecked: number;
  delisted: number;
  scored: number;
  notified: number;
  suppressedQuietHours: number;
  errors: string[];
}

/**
 * Two pages, not five.
 *
 * Page one carried 21 listings under 24 hours old, so a 20-minute cycle sees roughly four
 * genuinely new ads. Five pages was covering the same ground four times over and spending
 * requests against a rate limit that has already bitten twice.
 */
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_HYDRATION_BUDGET = 20;
const DEFAULT_RECHECK_BUDGET = 3;
/** How long a paused source is left alone. One cycle's worth. */
const SOURCE_COOLDOWN_MS = 20 * 60 * 1000;

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  /**
   * One source for the life of the process, not one per cycle.
   *
   * The rate limiter's circuit is the point: if Kijiji refused us at 10:00, a fresh instance
   * at 10:20 would have forgotten and gone straight back in. Keeping it means the pause is
   * real, and the gap between cycles becomes the backoff.
   */
  private readonly source = new KijijiSource(loadEnv().SCRAPER_CONTACT_EMAIL);
  private lastCycle: { finishedAt: Date; report: CycleReport } | null = null;
  /** Guards against alerting on every cycle for the same outage. */
  private alerted = false;

  constructor(
    private readonly profilesService: ProfilesService,
    private readonly geoService: GeoService,
    private readonly repo: ListingsRepository,
    private readonly notifier: TelegramNotifier,
    private readonly verifier: ListingVerifier,
  ) {}

  /** For /health: what the source is doing and how the last cycle went. */
  get status(): {
    source: { requests: number; paused: boolean; reason: string | null };
    lastCycleAt: string | null;
    lastCycle: CycleReport | null;
  } {
    return {
      source: this.source.stats,
      lastCycleAt: this.lastCycle?.finishedAt.toISOString() ?? null,
      lastCycle: this.lastCycle?.report ?? null,
    };
  }

  async runCycle(options: CycleOptions = {}): Promise<CycleReport> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const hydrationBudget = options.hydrationBudget ?? DEFAULT_HYDRATION_BUDGET;

    const report = emptyReport();

    const profiles = await this.profilesService.findActive();
    if (profiles.length === 0) {
      report.errors.push('no active profiles');
      return report;
    }

    const geo = this.geoService.get();
    const source: ListingSource = this.source;
    if (this.source.resetIfCooledDown(SOURCE_COOLDOWN_MS)) {
      this.logger.log('source cooldown elapsed — resuming');
      this.alerted = false;
    }

    // --- Stage A: triage -----------------------------------------------------------
    const candidates = new Map<string, { listing: TriageListing; listingId: string; profiles: TenantProfile[] }>();

    for (let page = 1; page <= maxPages; page += 1) {
      let triage;
      try {
        triage = await source.fetchTriagePage(page);
      } catch (err) {
        // A structural change at the source must be loud, not an empty cycle.
        report.errors.push(`page ${page}: ${(err as Error).message}`);
        break;
      }
      report.pagesFetched += 1;
      report.listingsSeen += triage.listings.length;
      report.unparsable += triage.unparsable.length;

      for (const unparsable of triage.unparsable) {
        // Not silently dropped: an ad we cannot price is still an ad we saw.
        for (const profile of profiles) {
          await this.repo.recordRejections(profile.id, source.name, unparsable.sourceId, unparsable.url, null, [
            { reason: 'unparsable', detail: { reason: unparsable.reason } },
          ]);
        }
      }

      for (const listing of triage.listings) {
        const fingerprint = fingerprintOf(listing);
        const stored = await this.repo.upsertListing(listing, fingerprint);
        if (stored.isNew) report.storedNew += 1;

        const interested: TenantProfile[] = [];
        for (const profile of profiles) {
          const outcome = applyHardFilters(listing, profile, geo);
          if (outcome.decision === 'reject') {
            tally(report.rejectedAtTriage, outcome.rejections.map((r) => r.reason));
            await this.repo.recordRejections(
              profile.id,
              source.name,
              listing.sourceId,
              listing.url,
              stored.id,
              outcome.rejections,
            );
            continue;
          }
          // 'review' means something is unknown — which is exactly what hydration resolves.
          interested.push(profile);
        }

        if (interested.length > 0) {
          candidates.set(listing.sourceId, { listing, listingId: stored.id, profiles: interested });
        }
      }
    }

    // --- Stage B: hydration --------------------------------------------------------
    const queue = [...candidates.values()];

    // Anything already hydrated is scored straight from the database. Without this, every
    // cycle would re-download the body of every candidate it has ever seen — which on a
    // 20-minute schedule is exactly how a source starts answering 429.
    const stored = await this.repo.findHydrated(
      'kijiji',
      queue.map((c) => c.listing.sourceId),
    );

    const fromCache = queue.filter((c) => stored.has(c.listing.sourceId));
    const needFetch = queue.filter((c) => !stored.has(c.listing.sourceId));
    const toFetch = needFetch.slice(0, hydrationBudget);
    report.reusedFromCache = fromCache.length;
    report.hydrationDeferred = needFetch.length - toFetch.length;

    for (const candidate of fromCache) {
      const enriched = listingFromRow(stored.get(candidate.listing.sourceId)!);
      await this.evaluate(enriched, candidate.listingId, candidate.profiles, geo, report, options, source.name);
    }

    for (const candidate of toFetch) {
      let enriched: TriageListing;
      try {
        const detail = await source.fetchDetail(candidate.listing);
        enriched = enrichFromText(candidate.listing, detail.descriptionHtml);
        report.hydrated += 1;
      } catch (err) {
        if (err instanceof SourcePausedError) {
          // The source has asked us to stop. Everything unhydrated rolls into the next
          // cycle, so nothing is lost by giving up here.
          report.errors.push((err as Error).message);
          report.hydrationDeferred += toFetch.length - report.hydrated;
          break;
        }
        report.errors.push(`detail ${candidate.listing.sourceId}: ${(err as Error).message}`);
        continue;
      }

      await this.repo.upsertListing(enriched, fingerprintOf(enriched));
      await this.repo.markHydrated(candidate.listingId);
      await this.evaluate(enriched, candidate.listingId, candidate.profiles, geo, report, options, source.name);
    }

    // --- Stage C: confirm the ones already found are still there ---------------------
    await this.recheck(source, options.recheckBudget ?? DEFAULT_RECHECK_BUDGET, report);

    this.lastCycle = { finishedAt: new Date(), report };
    await this.alertIfPaused(profiles, report);
    return report;
  }

  /**
   * Tells you when a source has stopped talking to us.
   *
   * A paused source produces empty cycles that look exactly like a quiet market, which is
   * the failure mode most likely to go unnoticed for a week. Sent once per pause, not once
   * per cycle, so a long outage does not itself become the spam.
   */
  private async alertIfPaused(profiles: TenantProfile[], report: CycleReport): Promise<void> {
    if (!this.source.paused || this.alerted) return;
    this.alerted = true;

    const reason = this.source.stats.reason ?? 'unknown';
    const recipients = [...new Set(profiles.flatMap((p) => p.notify.telegramChatIds))];
    await this.notifier.alert(
      recipients,
      `⚠️ <b>Kijiji paused</b>\n${escapeForAlert(reason)}\n\nNo new listings will be found until it recovers. ` +
        `The next cycle retries automatically after the cooldown.`,
    );
    if (report.errors.length === 0) report.errors.push(`source paused: ${reason}`);
  }

  /**
   * Asks the source whether listings we have already surfaced are still live.
   *
   * Delisting is confirmed, never presumed. An ad falls off the first pages within days
   * while remaining perfectly available, so absence proves nothing — only the ad's own
   * status does. Least-recently-confirmed first, so attention spreads evenly.
   */
  private async recheck(source: ListingSource, budget: number, report: CycleReport): Promise<void> {
    if (budget <= 0) return;

    for (const row of await this.repo.findForRecheck(budget)) {
      try {
        const detail = await source.fetchDetail(listingFromRow(row));
        report.rechecked += 1;
        if (detail.status !== null && detail.status.toUpperCase() !== 'ACTIVE') {
          await this.repo.markDelisted(row.id);
          report.delisted += 1;
          this.logger.log(`delisted ${row.sourceId}: status ${detail.status}`);
        } else {
          await this.repo.markStillListed(row.id);
        }
      } catch (err) {
        if (err instanceof SourcePausedError) {
          report.errors.push((err as Error).message);
          return;
        }
        report.errors.push(`recheck ${row.sourceId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Re-evaluates everything already collected, without touching the network.
   *
   * This is the calibration loop: change a weight, run this, and see what the current
   * profile makes of the corpus you already have. It also means a rate-limited or offline
   * source never blocks scoring, and notifications for listings collected earlier still go
   * out — the unique index on notifications keeps that from repeating anything.
   */
  async runFromStored(options: CycleOptions = {}): Promise<CycleReport> {
    const report = emptyReport();

    const profiles = await this.profilesService.findActive();
    if (profiles.length === 0) {
      report.errors.push('no active profiles');
      return report;
    }

    const geo = this.geoService.get();
    const rows = await this.repo.findAllHydrated();
    report.listingsSeen = rows.length;
    report.reusedFromCache = rows.length;

    for (const row of rows) {
      await this.evaluate(listingFromRow(row), row.id, profiles, geo, report, options, row.source);
    }

    return report;
  }

  /**
   * Reads the advertisement and acts on what it says, then records the verdict either way.
   *
   * Fails open by design: a verification that errors, refuses, or is unconfigured leaves the
   * listing exactly as it was and lets it through. Dropping a promising listing because an
   * API call failed would be a worse outcome than showing it unverified.
   */
  private async verifyBeforeNotifying(
    listing: TriageListing,
    listingId: string,
    profile: TenantProfile,
    geo: GeoIndex,
    report: CycleReport,
  ): Promise<{ listing: TriageListing; rejected: boolean; note: string | null }> {
    if (!this.verifier.configured) return { listing, rejected: false, note: null };

    // A stored verdict is re-applied, not skipped. Reading the advertisement again would be
    // pure cost — its text does not change — but the verdict's *effect* has to be applied on
    // every cycle, or a listing the model cut down to one bedroom quietly notifies later.
    const stored = await this.repo.findVerification(listingId);
    const cached = storedVerdict(stored);
    if (cached) return this.actOnVerdict(listing, listingId, profile, geo, report, cached, false);

    const result = await this.verifier.verify(listing);
    if (!result.ok) {
      await this.repo.recordVerification({ listingId, model: VERIFIER_MODEL, error: result.error });
      report.errors.push(`verify ${listing.sourceId}: ${result.error}`);
      return { listing, rejected: false, note: null };
    }

    report.verified += 1;
    return this.actOnVerdict(listing, listingId, profile, geo, report, result.verdict, true);
  }

  /** Applies a verdict — freshly read or replayed from the database — and records it. */
  private async actOnVerdict(
    listing: TriageListing,
    listingId: string,
    profile: TenantProfile,
    geo: GeoIndex,
    report: CycleReport,
    verdict: Verdict,
    persist: boolean,
  ): Promise<{ listing: TriageListing; rejected: boolean; note: string | null }> {
    const outcome = applyVerdict(listing, verdict, profile);
    if (persist) {
      await this.repo.recordVerification({
        listingId,
        model: VERIFIER_MODEL,
        bedrooms: verdict.bedrooms,
        dens: verdict.dens,
        isEntireUnit: verdict.isEntireUnit,
        isSplitDwelling: verdict.isSplitDwelling,
        confidence: verdict.confidence,
        evidence: verdict.evidence,
        notes: verdict.notes,
        applied: outcome.applied,
      });
    }

    if (outcome.reject) {
      report.verificationRejected += 1;
      this.logger.log(`verification rejected ${listing.sourceId}: ${outcome.reject.reason}`);
      await this.repo.recordRejections(
        profile.id,
        listing.source,
        listing.sourceId,
        listing.url,
        listingId,
        [outcome.reject],
      );
      return { listing, rejected: true, note: outcome.note };
    }

    if (outcome.applied) {
      report.verificationCorrected += 1;
      this.logger.log(`verification corrected ${listing.sourceId}: ${outcome.note}`);
      // Re-run the hard filters on the corrected layout — it can now fail the bedroom floor.
      const recheck = applyHardFilters(outcome.listing, profile, geo);
      if (recheck.decision === 'reject') {
        report.verificationRejected += 1;
        await this.repo.recordRejections(
          profile.id,
          listing.source,
          listing.sourceId,
          listing.url,
          listingId,
          recheck.rejections,
        );
        return { listing: outcome.listing, rejected: true, note: outcome.note };
      }
    }

    return { listing: outcome.listing, rejected: false, note: outcome.note };
  }

  /** Hard filters, score, persist and notify for one fully-hydrated listing. */
  private async evaluate(
    listing: TriageListing,
    listingId: string,
    profiles: TenantProfile[],
    geo: GeoIndex,
    report: CycleReport,
    options: CycleOptions,
    sourceName: string,
  ): Promise<void> {
    const fingerprint = fingerprintOf(listing);

    for (const profile of profiles) {
      const outcome = applyHardFilters(listing, profile, geo);
      if (outcome.decision === 'reject') {
        tally(report.rejectedAfterHydration, outcome.rejections.map((r) => r.reason));
        await this.repo.recordRejections(
          profile.id,
          sourceName,
          listing.sourceId,
          listing.url,
          listingId,
          outcome.rejections,
        );
        continue;
      }

      // A layout disagreement is not a hard-filter outcome — the filters ran on the
      // source's numbers and passed. It still has to surface, because those numbers are
      // what the layout ladder scored.
      const conflict = layoutConflictOf(listing);
      const reviews = conflict
        ? [
            ...outcome.reviews,
            {
              field: 'beds',
              reason: `source says ${conflict.structuredBeds} bedrooms, ad text says ${conflict.textBeds}`,
            },
          ]
        : outcome.reviews;

      if (reviews.length > 0) {
        await this.repo.recordReviews(profile.id, listingId, reviews);
        report.needsReview += reviews.length;
      }

      let scored = listing;
      let score = scoreListing({ listing: scored, profile, geo });
      await this.repo.upsertMatch(listingId, profile.id, score);
      report.scored += 1;

      if (score.score < profile.notify.minScore) continue;

      /**
       * Only listings about to take up someone's attention are read by the model — a handful
       * a day, not the whole funnel. The question it answers ("is this actually the unit the
       * fields claim?") is worth asking exactly here.
       */
      const verification = await this.verifyBeforeNotifying(scored, listingId, profile, geo, report);
      if (verification.rejected) continue;
      if (verification.listing !== scored) {
        scored = verification.listing;
        score = scoreListing({ listing: scored, profile, geo });
        await this.repo.upsertMatch(listingId, profile.id, score);
        // The corrected layout can drop it under the bar it had just cleared.
        if (score.score < profile.notify.minScore) continue;
      }

      if (!options.ignoreQuietHours && inQuietHours(profile)) {
        // Deferred, not dropped: nothing is claimed, so the next cycle sends it.
        report.suppressedQuietHours += 1;
        continue;
      }

      if (options.dryRun) continue;

      const { messageId } = await this.notifier.send({
        listing: scored,
        listingId,
        fingerprint,
        profileId: profile.id,
        chatIds: profile.notify.telegramChatIds,
        score,
        includeMap: profile.notify.includeMap,
        ...this.geoContext(scored, profile, geo),
        unverified: verification.note
          ? [...reviews, { field: 'layout', reason: verification.note }]
          : reviews,
      });
      if (messageId) report.notified += 1;
    }
  }

  private geoContext(
    listing: TriageListing,
    profile: TenantProfile,
    geo: GeoIndex,
  ): Pick<
    Parameters<TelegramNotifier['send']>[0],
    'reachableLines' | 'transitRadiusM' | 'daycaresNearby' | 'nearestDaycare' | 'mapStops'
  > {
    const cfg = profile.hard.minDaycaresWithin;
    const radiusM = cfg?.radiusM ?? 800;
    // Beyond the transit decay distance the score is zero anyway, so nothing further is
    // "reachable" as far as this profile is concerned.
    const transitRadiusM = profile.soft.transitWalkZeroM ?? profile.hard.maxTransitWalkM ?? 900;

    if (listing.lat === null || listing.lng === null) {
      return {
        reachableLines: [],
        transitRadiusM,
        daycaresNearby: { total: 0, cwelcc: 0, radiusM },
        nearestDaycare: null,
        mapStops: [],
      };
    }
    const point = { lat: listing.lat, lng: listing.lng };
    // daycaresWithin already returns them sorted by distance, so the first is the closest.
    const nearby = cfg ? geo.daycaresWithin(point, radiusM, cfg.ageGroup) : [];
    const closest = nearby[0];
    const lines = reachableLines(geo.stationsWithin(point, transitRadiusM, 'operational'));
    // Nearest station first, then the closest daycares: with only three slots, the station is
    // the one point the daycare count cannot stand in for.
    const mapStops = [
      ...lines.slice(0, 1).map((l) => ({ label: l.station, lat: l.lat, lng: l.lng })),
      ...nearby.slice(0, 3).map((n) => ({ label: n.daycare.name, lat: n.daycare.lat, lng: n.daycare.lng })),
    ];

    return {
      reachableLines: lines,
      transitRadiusM,
      mapStops,
      daycaresNearby: {
        total: nearby.length,
        cwelcc: nearby.filter((n) => n.daycare.cwelcc).length,
        radiusM,
      },
      nearestDaycare: closest
        ? {
            name: closest.daycare.name,
            distanceM: closest.distanceM,
            cwelcc: closest.daycare.cwelcc,
            lat: closest.daycare.lat,
            lng: closest.daycare.lng,
          }
        : null,
    };
  }
}

function fingerprintOf(listing: TriageListing): string {
  return buildFingerprint({
    address: listing.address,
    beds: listing.beds,
    dens: listing.dens,
    rentBase: listing.rentBase,
    fallback: `${listing.source}:${listing.sourceId}`,
  });
}

function tally(target: Record<string, number>, reasons: string[]): void {
  for (const reason of reasons) target[reason] = (target[reason] ?? 0) + 1;
}

/**
 * Quiet hours wrap around midnight: [22, 7] means 22:00 to 07:00. Evaluated in Toronto
 * time, since that is where both the tenant and the listings are.
 */
export function inQuietHours(profile: TenantProfile, now: Date = new Date()): boolean {
  const window = profile.notify.quietHours;
  if (!window) return false;
  const [start, end] = window;
  const hour = Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      hour: 'numeric',
      hour12: false,
    }).format(now),
  ) % 24;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function emptyReport(): CycleReport {
  return {
    pagesFetched: 0,
    listingsSeen: 0,
    unparsable: 0,
    storedNew: 0,
    rejectedAtTriage: {},
    hydrated: 0,
    reusedFromCache: 0,
    hydrationDeferred: 0,
    rejectedAfterHydration: {},
    needsReview: 0,
    verified: 0,
    verificationRejected: 0,
    verificationCorrected: 0,
    rechecked: 0,
    delisted: 0,
    scored: 0,
    notified: 0,
    suppressedQuietHours: 0,
    errors: [],
  };
}

function escapeForAlert(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rebuilds a verdict from its stored row, or null when the row only recorded a failure. */
function storedVerdict(row: ListingVerificationRow | null): Verdict | null {
  if (!row || row.error !== null) return null;
  const parsed = verdictSchema.safeParse({
    bedrooms: row.bedrooms,
    dens: row.dens,
    isEntireUnit: row.isEntireUnit,
    isSplitDwelling: row.isSplitDwelling,
    confidence: row.confidence,
    evidence: row.evidence ?? '',
    notes: row.notes ?? '',
  });
  return parsed.success ? parsed.data : null;
}
