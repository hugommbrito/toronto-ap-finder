import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '@/config/env';
import { buildFingerprint } from '@/geo/address';
import { GeoService } from '@/geo/geo.service';
import { enrichFromText, layoutConflictOf } from '@/listings/enrich';
import { listingFromRow, type TriageListing } from '@/listings/listing.types';
import { ListingsRepository, MAX_MISSED_SWEEPS } from '@/listings/listings.repository';
import type { ListingRow, ListingVerificationRow, SourceBuildingRow } from '@/db/schema';
import type { BuildingEntry } from '@/sources/source.interface';
import { TelegramNotifier } from '@/notifications/telegram.notifier';
import type { TenantProfile } from '@/profiles/profile.schema';
import { ProfilesService } from '@/profiles/profiles.service';
import { applyHardFilters, type HardFilterResult } from '@/scoring/hard-filters';
import { scoreListing } from '@/scoring/scorer';
import { reachableLines, type GeoIndex } from '@/scoring/context';
import { SourceRegistry, newlyPaused } from '@/sources/source.registry';
import { SourcePausedError } from '@/sources/rate-limiter';
import { ListingVerifier, VERIFIER_MODEL, verdictSchema, type Verdict } from '@/verification/listing-verifier';
import { RentSafeService } from '@/rentsafe/rentsafe.service';
import { applyRentSafe } from '@/rentsafe/apply';
import { applyVerdict } from '@/verification/apply-verdict';
import type { BuildingListingSource, SourceHealth, UnitListingSource } from '@/sources/source.interface';

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
  rentsafeMatched: number;
  rentsafeUnmatched: number;
  verified: number;
  verificationRejected: number;
  verificationCorrected: number;
  /** Buildings enumerated by a building-granularity source, and how many were opened. */
  buildingsSeen: number;
  buildingsExpanded: number;
  buildingsDeferred: number;
  unitsFound: number;
  rechecked: number;
  delisted: number;
  scored: number;
  notified: number;
  suppressedQuietHours: number;
  /** Notified by draining the backlog rather than by being seen in this cycle's sweep. */
  notifiedFromBacklog: number;
  errors: string[];
}

/**
 * Two pages, not five.
 *
 * Page one carried 21 listings under 24 hours old, so a cycle at this cadence sees roughly four
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
   * One slot per kind of cycle, not one for both.
   *
   * A single field meant the building cycle at :10 overwrote the listings report from :00, so
   * /health's numbers described whichever ran last and nobody could tell.
   */
  private readonly lastCycles = new Map<'unit' | 'building', { finishedAt: Date; report: CycleReport }>();
  /** Which sources have already been announced as paused. One alert per pause, per source. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly profilesService: ProfilesService,
    private readonly geoService: GeoService,
    private readonly repo: ListingsRepository,
    private readonly notifier: TelegramNotifier,
    private readonly verifier: ListingVerifier,
    private readonly registry: SourceRegistry,
    private readonly rentsafe: RentSafeService,
  ) {}

  /** For /health: what every source is doing, and how each kind of cycle last went. */
  get status(): {
    sources: Record<string, { requests: number; paused: boolean; reason: string | null }>;
    pausedSources: string[];
    lastCycleAt: string | null;
    lastCycle: CycleReport | null;
  } {
    const unit = this.lastCycles.get('unit');
    return {
      sources: this.registry.health(),
      pausedSources: this.registry.pausedSources(),
      lastCycleAt: unit?.finishedAt.toISOString() ?? null,
      lastCycle: unit?.report ?? null,
    };
  }

  async runCycle(options: CycleOptions = {}): Promise<CycleReport> {
    const startedAt = new Date();
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const hydrationBudget = options.hydrationBudget ?? DEFAULT_HYDRATION_BUDGET;

    const report = emptyReport();

    const profiles = await this.profilesService.findActive();
    if (profiles.length === 0) {
      report.errors.push('no active profiles');
      return report;
    }

    const geo = this.geoService.get();

    await this.drainBacklog(profiles, geo, report, options);

    const source = this.registry.unitSources()[0];
    if (!source) {
      report.errors.push('no unit sources registered');
      return report;
    }
    if (source.resetIfCooledDown(SOURCE_COOLDOWN_MS)) {
      this.logger.log(`${source.name} cooldown elapsed — resuming`);
      this.alerted.delete(source.name);
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
    // schedule this frequent is exactly how a source starts answering 429.
    // Keyed on the source that produced them. Hardcoding 'kijiji' here would silently return
    // nothing the moment anything else ran through this method, defeating the cache whose whole
    // job is to stop us re-downloading every candidate we have ever seen.
    const stored = await this.repo.findHydrated(
      source.name,
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
    await this.recheck(source, profiles, options.recheckBudget ?? DEFAULT_RECHECK_BUDGET, report);

    await this.finish('unit', 'listings', source.name, startedAt, report);
    await this.alertIfPaused(profiles, report);
    return report;
  }

  /**
   * A cycle over a source that advertises buildings rather than units.
   *
   * The stages carry different meanings here than they do for Kijiji. Enumeration is cheap
   * and returns containers, not listings — a price range over many floorplans answers no
   * question the profile asks. Opening one container is the expensive request, and it
   * returns *many* units, descriptions included, so there is no third stage.
   *
   * What keeps this affordable is the watermark, not a pre-filter: filtering buildings by
   * price and bedroom range keeps 87 of 90, because a building's minimum price is always its
   * cheapest studio. A building whose `modified_on` has not advanced since we last opened it
   * is skipped instead.
   */
  async runBuildingCycle(options: CycleOptions = {}): Promise<CycleReport> {
    const report = emptyReport();

    const profiles = await this.profilesService.findActive();
    if (profiles.length === 0) {
      report.errors.push('no active profiles');
      return report;
    }
    const geo = this.geoService.get();

    // Before collecting anything new: whatever quiet hours deferred is older than anything
    // this cycle will find, and for a building source nothing else will look at it again.
    await this.drainBacklog(profiles, geo, report, options);

    // Sequential, not Promise.all. Each source holds its own limiter so parallel fetching would
    // be safe on the network, but they share this report and the database, and the budgets are
    // small enough that the ordering buys nothing worth the interleaving.
    for (const source of this.registry.buildingSources()) {
      const startedAt = new Date();
      const before = report.errors.length;
      try {
        await this.runOneBuildingSource(source, profiles, geo, options, report);
      } catch (err) {
        // One source failing must not abort the others; that is the whole reason for the loop.
        report.errors.push(`${source.name}: ${(err as Error).message}`);
      }
      await this.recordRun('buildings', source.name, startedAt, report, report.errors.slice(before));
    }

    this.lastCycles.set('building', { finishedAt: new Date(), report });
    // A paused Zumper used to alert nobody, because this method never asked.
    await this.alertIfPaused(profiles, report);
    return report;
  }

  /** One building source, from enumeration to notification. */
  private async runOneBuildingSource(
    source: BuildingListingSource,
    profiles: TenantProfile[],
    geo: GeoIndex,
    options: CycleOptions,
    report: CycleReport,
  ): Promise<void> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const expansionBudget = options.hydrationBudget ?? DEFAULT_HYDRATION_BUDGET;
    if (source.resetIfCooledDown(SOURCE_COOLDOWN_MS)) {
      this.logger.log(`${source.name} cooldown elapsed — resuming`);
      this.alerted.delete(source.name);
    }

    // --- Stage A: enumerate buildings ------------------------------------------------
    for (let page = 1; page <= maxPages; page += 1) {
      try {
        const result = await source.fetchBuildingPage(page);
        report.pagesFetched += 1;
        report.buildingsSeen += result.buildings.length;
        report.unparsable += result.unparsable.length;
        // Pages overlap — featured placements repeat across them — so the upsert, not the
        // page boundary, is what deduplicates.
        await this.repo.upsertBuildings(source.name, result.buildings);
        if (result.buildings.length === 0) break;
      } catch (err) {
        report.errors.push(`${source.name} page ${page}: ${(err as Error).message}`);
        break;
      }
    }

    // --- Stage B: open the ones that changed -----------------------------------------
    const toOpen = await this.repo.findBuildingsDueForExpansion(source.name, expansionBudget, source.refreshEveryMs);
    // Counted rather than inferred from the page of work taken: a backlog of 96 reported as
    // "1 deferred" is how a backfill that will never finish looks finished.
    const backlog = await this.repo.countBuildingsDueForExpansion(source.name, source.refreshEveryMs);
    report.buildingsDeferred = Math.max(0, backlog - toOpen.length);

    for (const row of toOpen) {
      let units: TriageListing[];
      try {
        units = await source.fetchUnits(buildingFromRow(row));
        report.buildingsExpanded += 1;
      } catch (err) {
        if (err instanceof SourcePausedError) {
          report.errors.push((err as Error).message);
          break;
        }
        report.errors.push(`${source.name} building ${row.sourceId}: ${(err as Error).message}`);
        continue;
      }

      // The watermark advances even when a building yields nothing usable. Otherwise an
      // all-unpriced building would be reopened on every cycle, forever.
      await this.repo.markBuildingExpanded(row.id, row.modifiedOn, units.length);
      report.unitsFound += units.length;
      report.listingsSeen += units.length;

      for (const unit of units) {
        // Units arrive with their body already attached, so enrichment reads the text we
        // have rather than fetching one.
        const enriched = enrichFromText(unit, unit.rawText ?? '');
        const stored = await this.repo.upsertListing(enriched, fingerprintOf(enriched));
        if (stored.isNew) report.storedNew += 1;
        await this.repo.markHydrated(stored.id);
        await this.evaluate(enriched, stored.id, profiles, geo, report, options, source.name);
      }
    }
  }

  /** Marks a unit cycle finished: remembers it for /health and records it for the history. */
  private async finish(
    slot: 'unit' | 'building',
    kind: string,
    source: string | null,
    startedAt: Date,
    report: CycleReport,
  ): Promise<void> {
    this.lastCycles.set(slot, { finishedAt: new Date(), report });
    await this.recordRun(kind, source, startedAt, report, report.errors);
  }

  /**
   * Writes the cycle to the history.
   *
   * Never allowed to fail the cycle: the run already happened, and losing the record of it is a
   * strictly smaller problem than throwing away the work that produced it.
   */
  private async recordRun(
    kind: string,
    source: string | null,
    startedAt: Date,
    report: CycleReport,
    errors: string[],
  ): Promise<void> {
    try {
      await this.repo.recordCycleRun({
        kind,
        source,
        startedAt,
        finishedAt: new Date(),
        ok: errors.length === 0,
        report: report as unknown as Record<string, unknown>,
        errors,
      });
    } catch (err) {
      this.logger.error(`could not record cycle run: ${(err as Error).message}`);
    }
  }

  /**
   * Tells you when a source has stopped talking to us.
   *
   * A paused source produces empty cycles that look exactly like a quiet market, which is the
   * failure mode most likely to go unnoticed for a week. Sent once per pause **per source**, not
   * once per cycle, so a long outage does not itself become the spam — but a second source going
   * down during the first one's outage is news, and still gets said.
   */
  private async alertIfPaused(profiles: TenantProfile[], report: CycleReport): Promise<void> {
    const paused = newlyPaused(this.registry.all(), this.alerted);
    if (paused.length === 0) return;
    for (const source of paused) this.alerted.add(source.name);

    const lines = paused.map(
      (s) => `• <b>${escapeForAlert(s.name)}</b>: ${escapeForAlert(s.stats.reason ?? 'unknown')}`,
    );
    const recipients = [...new Set(profiles.flatMap((p) => p.notify.telegramChatIds))];
    await this.notifier.alert(
      recipients,
      `⚠️ <b>Source paused</b>\n${lines.join('\n')}\n\nNo new listings will be found from ` +
        `${paused.length === 1 ? 'it' : 'them'} until recovery. The next cycle retries ` +
        `automatically after the cooldown.`,
    );
    if (report.errors.length === 0) {
      report.errors.push(`source paused: ${paused.map((s) => s.name).join(', ')}`);
    }
  }

  /**
   * Asks the source whether listings we have already surfaced are still live.
   *
   * Delisting is confirmed, never presumed. An ad falls off the first pages within days
   * while remaining perfectly available, so absence proves nothing — only the ad's own
   * status does. Least-recently-confirmed first, so attention spreads evenly.
   */
  private async recheck(
    source: UnitListingSource,
    profiles: TenantProfile[],
    budget: number,
    report: CycleReport,
  ): Promise<void> {
    if (budget <= 0) return;

    // Its own source, and only its own. Handing this source another's listing means fetching
    // that site's URL with this adapter's parser and this adapter's rate limiter — which is
    // exactly how a Zumper listing came to be reported as Kijiji changing its markup.
    for (const row of await this.repo.findForRecheck(source.name, budget)) {
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
        // Count the failure against the listing, so an advertisement we cannot read stops
        // taking a request every cycle. Never delisted on this basis: being unable to read an
        // ad is not evidence that the ad is gone.
        const missed = await this.repo.markRecheckFailed(row.id);
        report.errors.push(`recheck ${row.sourceId}: ${(err as Error).message}`);
        if (missed >= MAX_MISSED_SWEEPS) {
          this.logger.warn(`${row.sourceId} retired from re-checking after ${missed} unreadable attempts`);
          for (const profile of profiles) {
            await this.repo.recordReviews(profile.id, row.id, [
              { field: 'status', reason: `could not be re-checked ${missed} times: ${(err as Error).message}` },
            ]);
          }
          report.needsReview += profiles.length;
        }
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
    const startedAt = new Date();
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

    // Recorded with a null source: this run touches no source at all, and charging it to one
    // would make a calibration pass look like collection activity in the operations report.
    await this.recordRun('stored', null, startedAt, report, report.errors);
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

    // Resolved once, outside the profile loop: which building an advertisement is in is a fact
    // about the advertisement, not a judgement any profile makes.
    const matched = this.rentsafe.get().match(listing);
    if (matched) {
      report.rentsafeMatched += 1;
      const enriched = applyRentSafe(listing, matched.building);
      await this.repo.linkRentSafe(
        listingId,
        matched.building.rsn,
        matched.tier,
        enriched.buildingBuiltBefore2018,
      );
      listing = enriched;
    } else {
      report.rentsafeUnmatched += 1;
    }
    const building = matched
      ? { rsn: matched.building.rsn, score: matched.building.score, yearBuilt: matched.building.yearBuilt }
      : null;

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
      let score = scoreListing({ listing: scored, profile, geo, building });
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
        score = scoreListing({ listing: scored, profile, geo, building });
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

  /**
   * Sends what quiet hours deferred but no later sweep picked up again.
   *
   * Suppression inside quiet hours deliberately claims nothing, so that the next cycle can
   * deliver the listing instead. That relies on the listing being *seen* again, which a unit
   * source does on every sweep but a building source only does when the building's watermark
   * moves — so an advertisement first seen at 03:00 could be scored once, deferred, and then
   * never re-examined. This drains by query instead, which does not depend on re-discovery.
   *
   * Runs at the top of a cycle, before new listings are collected: the backlog is older than
   * anything this cycle will find, and a listing already delisted is skipped by the query.
   */
  private async drainBacklog(
    profiles: TenantProfile[],
    geo: GeoIndex,
    report: CycleReport,
    options: CycleOptions,
  ): Promise<void> {
    if (options.dryRun) return;

    for (const profile of profiles) {
      if (!options.ignoreQuietHours && inQuietHours(profile)) continue;

      let pending: Array<{ listing: ListingRow; score: number }>;
      try {
        pending = await this.repo.findUnnotifiedMatches(profile.id, backlogSince());
      } catch (err) {
        report.errors.push(`backlog ${profile.id}: ${(err as Error).message}`);
        continue;
      }

      for (const row of pending) {
        if (row.score < profile.notify.minScore) continue;

        const listing = listingFromRow(row.listing);
        // Re-scored rather than trusted: the stored score was computed against whatever the
        // geo and RentSafe indexes held at the time, and the profile may have changed since.
        const matched = this.rentsafe.get().match(listing);
        const building = matched
          ? { rsn: matched.building.rsn, score: matched.building.score, yearBuilt: matched.building.yearBuilt }
          : null;
        const outcome = applyHardFilters(listing, profile, geo);
        if (outcome.decision === 'reject') continue;

        const score = scoreListing({ listing, profile, geo, building });
        if (score.score < profile.notify.minScore) continue;

        const verification = await this.verifyBeforeNotifying(listing, row.listing.id, profile, geo, report);
        if (verification.rejected) continue;

        const finalListing = verification.listing;
        const finalScore =
          finalListing === listing ? score : scoreListing({ listing: finalListing, profile, geo, building });
        if (finalScore.score < profile.notify.minScore) continue;

        const { messageId } = await this.notifier.send({
          listing: finalListing,
          listingId: row.listing.id,
          fingerprint: row.listing.fingerprint,
          profileId: profile.id,
          chatIds: profile.notify.telegramChatIds,
          score: finalScore,
          includeMap: profile.notify.includeMap,
          ...this.geoContext(finalListing, profile, geo),
          unverified: verification.note ? [{ field: 'layout', reason: verification.note }] : [],
        });
        if (messageId) {
          report.notified += 1;
          report.notifiedFromBacklog += 1;
          this.logger.log(`backlog notify ${row.listing.sourceId} (score ${finalScore.score.toFixed(1)})`);
        }
      }
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

/**
 * How far back the backlog drain looks.
 *
 * Long enough to cover a full quiet-hours window plus the gap until the first cycle that can
 * act on it, short enough that a listing nobody sent for days is not suddenly delivered as if
 * it were new. A unit that is still worth seeing after this long will be re-found by a sweep.
 */
const BACKLOG_WINDOW_MS = 24 * 60 * 60 * 1000;

function backlogSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - BACKLOG_WINDOW_MS);
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
    rentsafeMatched: 0,
    rentsafeUnmatched: 0,
    verified: 0,
    verificationRejected: 0,
    verificationCorrected: 0,
    buildingsSeen: 0,
    buildingsExpanded: 0,
    buildingsDeferred: 0,
    unitsFound: 0,
    rechecked: 0,
    delisted: 0,
    scored: 0,
    notified: 0,
    notifiedFromBacklog: 0,
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

/** The stored row, back in the shape the source adapter expects. */
function buildingFromRow(row: SourceBuildingRow): BuildingEntry {
  return {
    sourceId: row.sourceId,
    url: row.url,
    name: row.name ?? '',
    address: row.address,
    city: null,
    lat: row.lat,
    lng: row.lng,
    minPrice: null,
    maxPrice: null,
    minBedrooms: null,
    maxBedrooms: null,
    floorplanCount: row.floorplanCount ?? 0,
    modifiedOn: row.modifiedOn,
    // Building-wide amenities are re-read from the building page itself, so the stored row
    // does not need to carry them.
    amenityTags: [],
  };
}
