import { Injectable } from '@nestjs/common';
import type { CycleRunRow } from '@/db/schema';
import { ListingsRepository } from '@/listings/listings.repository';
import { ProbeService } from '@/sources/probe/probe.service';
import { SourceRegistry } from '@/sources/source.registry';

/** How a single source has been doing over the window. */
export interface SourceOperations {
  cycles: number;
  failed: number;
  paused: boolean;
  pausedReason: string | null;
  requestsThisProcess: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  policy: { verdict: string; antibot: string; robots: string; probedAt: string } | null;
}

export interface OperationsReport {
  window: { hours: number; since: string; now: string };
  /** Null until a cycle has ever finished — a fresh install, not a fault. */
  lastCycleAt: string | null;
  minutesSinceLastCycle: number | null;
  sources: Record<string, SourceOperations>;
  totals: Record<string, number>;
  /** Rejection reasons over the window: the funnel, and the instrument for reading it. */
  funnel: Record<string, number>;
  openReviews: number;
  probedFrom: string;
  runs: Array<{
    kind: string;
    source: string | null;
    startedAt: string;
    durationSec: number;
    ok: boolean;
    errors: string[];
  }>;
}

/** Counters worth adding up across runs. Anything else in a report is per-cycle detail. */
const SUMMED = [
  'listingsSeen',
  'storedNew',
  'hydrated',
  'reusedFromCache',
  'buildingsSeen',
  'buildingsExpanded',
  'unitsFound',
  'scored',
  'notified',
  'rechecked',
  'delisted',
  'needsReview',
  'verified',
] as const;

/**
 * What has been happening, assembled for one HTTP response.
 *
 * The question it answers is the one `/health` cannot: `/health` says whether the process is up
 * right now, and this says whether the work has been getting done. They are different failures —
 * a monitor that is perfectly healthy and has collected nothing for two days looks fine to a
 * liveness check and is completely broken.
 *
 * It is also the trip-wire for the collector contingency in `docs/collector-contingency.md`:
 * moving the fetcher onto a residential connection is worth doing when, and only when, collection
 * from the cloud starts failing. This is where that shows up.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly repo: ListingsRepository,
    private readonly registry: SourceRegistry,
    private readonly probe: ProbeService,
  ) {}

  async report(hours: number): Promise<OperationsReport> {
    const now = new Date();
    const since = new Date(now.getTime() - hours * 3_600_000);

    const [runs, funnelRows, openReviews, lastCycleAt] = await Promise.all([
      this.repo.findCycleRuns(since),
      this.repo.rejectionTally(since),
      this.repo.openReviewCount(),
      this.repo.lastCycleFinishedAt(),
    ]);

    // A probe failure must not take the whole report down: the cycle history is the part being
    // asked for, and policy is context.
    let policies: Awaited<ReturnType<ProbeService['currentPolicies']>> = [];
    try {
      policies = await this.probe.currentPolicies();
    } catch {
      policies = [];
    }

    return {
      window: { hours, since: since.toISOString(), now: now.toISOString() },
      lastCycleAt: lastCycleAt?.toISOString() ?? null,
      minutesSinceLastCycle: lastCycleAt
        ? Math.round((now.getTime() - lastCycleAt.getTime()) / 60_000)
        : null,
      sources: this.perSource(runs, policies),
      totals: sumReports(runs),
      funnel: Object.fromEntries(funnelRows.map((r) => [r.reason, r.count])),
      openReviews,
      probedFrom: this.probe.probedFrom,
      runs: runs.map((r) => ({
        kind: r.kind,
        source: r.source,
        startedAt: r.startedAt.toISOString(),
        durationSec: Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000),
        ok: r.ok,
        errors: r.errors,
      })),
    };
  }

  private perSource(
    runs: CycleRunRow[],
    policies: Array<{ sourceId: string; verdict: string; antibotVendor: string; robotsTxtVerdict: string; probedAt: Date }>,
  ): Record<string, SourceOperations> {
    const byId = new Map(policies.map((p) => [p.sourceId, p]));
    const out: Record<string, SourceOperations> = {};

    // Keyed on the registry, not on the runs: a source that has not run at all in the window is
    // exactly the one worth seeing, and grouping by what did run would hide it.
    for (const source of this.registry.all()) {
      const mine = runs.filter((r) => r.source === source.name);
      const ok = mine.filter((r) => r.ok);
      const failed = mine.filter((r) => !r.ok);
      const policy = byId.get(source.name);

      out[source.name] = {
        cycles: mine.length,
        failed: failed.length,
        paused: source.paused,
        pausedReason: source.stats.reason,
        // Resets on redeploy, unlike everything else here, and labelled so it cannot be misread.
        requestsThisProcess: source.stats.requests,
        lastSuccessAt: ok[0]?.finishedAt.toISOString() ?? null,
        lastFailureAt: failed[0]?.finishedAt.toISOString() ?? null,
        lastError: failed[0]?.errors[0] ?? null,
        policy: policy
          ? {
              verdict: policy.verdict,
              antibot: policy.antibotVendor,
              robots: policy.robotsTxtVerdict,
              probedAt: policy.probedAt.toISOString(),
            }
          : null,
      };
    }

    return out;
  }
}

/** Adds up the counters that mean something summed; runs are already newest-first. */
function sumReports(runs: CycleRunRow[]): Record<string, number> {
  const totals: Record<string, number> = Object.fromEntries(SUMMED.map((k) => [k, 0]));
  for (const run of runs) {
    for (const key of SUMMED) {
      const value = run.report[key];
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
    }
  }
  totals.cycles = runs.length;
  totals.failedCycles = runs.filter((r) => !r.ok).length;
  return totals;
}
