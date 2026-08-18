import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { loadEnv, userAgent, APP_NAME } from '@/config/env';
import type { Database } from '@/db/client';
import { sourcePolicy, type SourcePolicyRow } from '@/db/schema';
import { TelegramNotifier } from '@/notifications/telegram.notifier';
import { ProfilesService } from '@/profiles/profiles.service';
import { sleep } from '@/seed/http';
import {
  classifyAntibot,
  embeddedJsonHint,
  isChallengePage,
  isDegradation,
  verdictFor,
  type AntibotVendor,
  type ProbeVerdict,
} from './antibot';
import { isAllowed, parseRobots, pathAndQuery, type RobotsVerdict } from './robots';
import { PROBE_TARGETS, type ProbeTarget } from './probe-targets';

/** Weekly, on Monday at 04:17 — deliberately off the rhythm of the collection cycles. */
export const PROBE_CRON = '17 4 * * 1';

/** One request, one attempt. A probe that retried a challenge would be arguing with the answer. */
const PROBE_TIMEOUT_MS = 15_000;
/** Courtesy gap between the two requests this makes to the same host. */
const INTER_REQUEST_MS = 2_000;

export interface ProbeResult {
  sourceId: string;
  probedAt: Date;
  probedFrom: string;
  targetUrl: string;
  httpStatus: number;
  responseTimeMs: number;
  antibotVendor: AntibotVendor;
  contentInInitialHtml: boolean;
  requiresJs: boolean;
  robotsTxtVerdict: RobotsVerdict;
  verdict: ProbeVerdict;
  jsonEndpointHint: string | null;
  notes: string | null;
  rawHeaders: Record<string, string>;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
  elapsedMs: number;
}

/**
 * Measures what each source does when we knock, and says so when the answer changes.
 *
 * This replaces a human process. Until now robots.txt was read by hand, the conclusion written into
 * `docs/sources/<id>.md`, and enforced by URL builders whose tests assert a disallowed form can
 * never be emitted. That enforcement stays — it is better than a runtime check — but nothing was
 * re-reading the file, so the documents could go quietly out of date. This is what re-reads them.
 *
 * Advisory on purpose: no verdict here stops a fetch. A transient 503 must not be able to silence
 * the monitor for a week.
 */
@Injectable()
export class ProbeService {
  private readonly logger = new Logger(ProbeService.name);

  constructor(
    @Inject('DATABASE') private readonly db: Database,
    private readonly notifier: TelegramNotifier,
    private readonly profilesService: ProfilesService,
  ) {}

  /**
   * Where we asked from.
   *
   * The whole point of recording it: anti-bot systems keep reputation by IP range, so a verdict is
   * a fact about a (source, vantage point) pair. On Railway this names the environment and region;
   * on a laptop it names the host, which is why a local run cannot be mistaken for the deployment.
   */
  get probedFrom(): string {
    const env = loadEnv();
    if (env.PROBE_HOST_LABEL) return env.PROBE_HOST_LABEL;
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME;
    if (railwayEnv) {
      const region = process.env.RAILWAY_REPLICA_REGION;
      return region ? `railway:${railwayEnv}:${region}` : `railway:${railwayEnv}`;
    }
    return `local:${hostname()}`;
  }

  @Cron(PROBE_CRON, { name: 'source-probe' })
  async runScheduledProbe(): Promise<void> {
    if (process.env.PROBE_ENABLED === 'false') return;
    try {
      await this.probeAll();
    } catch (err) {
      // Never let a failed probe take the process down; the cycles are the actual job.
      this.logger.error(`probe failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  /** Probes every target. `persist: false` measures and prints without writing. */
  async probeAll(options: { persist?: boolean } = {}): Promise<ProbeResult[]> {
    const persist = options.persist ?? true;
    const results: ProbeResult[] = [];
    const degraded: Array<{ result: ProbeResult; previous: ProbeVerdict }> = [];

    for (const target of PROBE_TARGETS) {
      let result: ProbeResult;
      try {
        result = await this.probeOne(target);
      } catch (err) {
        this.logger.error(`${target.id}: ${(err as Error).message}`);
        continue;
      }

      results.push(result);
      this.logger.log(
        `${result.sourceId}: ${result.verdict} (HTTP ${result.httpStatus}, ${result.antibotVendor}, ` +
          `content ${result.contentInInitialHtml ? 'in html' : 'absent'}, robots ${result.robotsTxtVerdict})`,
      );

      if (!persist) continue;
      const previous = await this.findPolicy(result.sourceId, result.probedFrom);
      await this.persist(result, previous);
      const previousVerdict = (previous?.verdict as ProbeVerdict | undefined) ?? null;
      if (isDegradation(previousVerdict, result.verdict)) {
        degraded.push({ result, previous: previousVerdict! });
      }
    }

    if (degraded.length > 0) await this.alertDegraded(degraded);
    return results;
  }

  private async probeOne(target: ProbeTarget): Promise<ProbeResult> {
    const probedFrom = this.probedFrom;
    const origin = new URL(target.url).origin;

    // robots.txt first, because it is the permission and the page is the measurement. This is the
    // second request the addendum's "one request per source" does not budget for, and it is
    // precisely the manual check being automated.
    const robots = await this.fetchRaw(`${origin}/robots.txt`);
    const { robotsTxtVerdict, robotsChallenged } = this.readRobots(robots, target.url);

    await sleep(INTER_REQUEST_MS);
    const page = await this.fetchRaw(target.url);

    const vendor = classifyAntibot({
      status: page.status,
      headers: page.headers,
      setCookies: page.setCookies,
      body: page.body,
    });
    const contentInInitialHtml = target.contentMarker.test(page.body);
    const challenged = isChallengePage(page.body);

    const { verdict, requiresJs, notes } = verdictFor({
      status: page.status,
      vendor,
      contentInInitialHtml,
      challenged,
      robotsTxtVerdict,
      robotsChallenged,
    });

    return {
      sourceId: target.id,
      probedAt: new Date(),
      probedFrom,
      targetUrl: target.url,
      httpStatus: page.status,
      responseTimeMs: page.elapsedMs,
      antibotVendor: vendor,
      contentInInitialHtml,
      requiresJs,
      robotsTxtVerdict,
      verdict,
      // Only interesting when the marker missed: it separates our own stale parser from a page
      // that genuinely assembles itself in the browser.
      jsonEndpointHint: contentInInitialHtml ? null : embeddedJsonHint(page.body),
      notes,
      rawHeaders: page.headers,
    };
  }

  /**
   * A 404 on robots.txt means no rules exist, which RFC 9309 reads as permission. A 403 or a
   * challenge means something quite different: the permission cannot be read, so there is no basis
   * on which to claim any path is allowed.
   */
  private readRobots(
    response: RawResponse,
    targetUrl: string,
  ): { robotsTxtVerdict: RobotsVerdict; robotsChallenged: boolean } {
    if (response.status === 200) {
      const rules = parseRobots(response.body, APP_NAME);
      return {
        robotsTxtVerdict: isAllowed(rules, pathAndQuery(targetUrl)) ? 'allow' : 'disallow',
        robotsChallenged: false,
      };
    }
    const challenged = response.status === 403 || isChallengePage(response.body);
    return { robotsTxtVerdict: 'absent', robotsChallenged: challenged };
  }

  /**
   * Raw `undici`, not the shared `fetchText`.
   *
   * `fetchText` retries, and throws on 403 and 429 so a caller's rate limiter can stop the source.
   * Both behaviours are wrong here: a probe must *record* a 403 rather than raise it, and retrying
   * a challenge is arguing with an answer already given.
   */
  private async fetchRaw(url: string): Promise<RawResponse> {
    const startedAt = Date.now();
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent(loadEnv().SCRAPER_CONTACT_EMAIL), accept: '*/*' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
    const body = await res.text();

    const headers: Record<string, string> = {};
    for (const [name, value] of res.headers.entries()) {
      // Never store a cookie value. A `cf_clearance` in the database is a kept challenge token,
      // which is the first step of working around a challenge instead of respecting it.
      if (name.toLowerCase() === 'set-cookie') continue;
      headers[name.toLowerCase()] = value;
    }
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length > 0) {
      headers['set-cookie-names'] = setCookies.map((c) => c.split('=')[0]!.trim()).join(', ');
    }

    return { status: res.status, headers, setCookies, body, elapsedMs: Date.now() - startedAt };
  }

  async findPolicy(sourceId: string, probedFrom: string): Promise<SourcePolicyRow | null> {
    const [row] = await this.db
      .select()
      .from(sourcePolicy)
      .where(and(eq(sourcePolicy.sourceId, sourceId), eq(sourcePolicy.probedFrom, probedFrom)))
      .limit(1);
    return row ?? null;
  }

  /** Every verdict this host has recorded, for /health and the operations route. */
  async currentPolicies(): Promise<SourcePolicyRow[]> {
    return this.db.select().from(sourcePolicy).where(eq(sourcePolicy.probedFrom, this.probedFrom));
  }

  private async persist(result: ProbeResult, previous: SourcePolicyRow | null): Promise<void> {
    const changed = previous !== null && previous.verdict !== result.verdict;
    const values = {
      sourceId: result.sourceId,
      probedFrom: result.probedFrom,
      probedAt: result.probedAt,
      targetUrl: result.targetUrl,
      httpStatus: result.httpStatus,
      responseTimeMs: result.responseTimeMs,
      antibotVendor: result.antibotVendor,
      contentInInitialHtml: result.contentInInitialHtml,
      requiresJs: result.requiresJs,
      robotsTxtVerdict: result.robotsTxtVerdict,
      verdict: result.verdict,
      // Carried forward when nothing moved, so the column always answers "what did it use to say?"
      previousVerdict: changed ? previous.verdict : (previous?.previousVerdict ?? null),
      verdictChangedAt: changed ? result.probedAt : (previous?.verdictChangedAt ?? null),
      jsonEndpointHint: result.jsonEndpointHint,
      notes: result.notes,
      rawHeaders: result.rawHeaders,
    };

    await this.db
      .insert(sourcePolicy)
      .values(values)
      .onConflictDoUpdate({ target: [sourcePolicy.sourceId, sourcePolicy.probedFrom], set: values });
  }

  /**
   * One message for the whole run, on the transition only.
   *
   * A source going from green to anything else is the event worth waking someone for: it is the
   * moment an adapter that has been working starts to be worked against, and it will otherwise show
   * up as a slow decline in listings that reads exactly like a quiet market.
   */
  private async alertDegraded(degraded: Array<{ result: ProbeResult; previous: ProbeVerdict }>): Promise<void> {
    const lines = degraded.map(
      ({ result, previous }) =>
        `• <b>${escapeHtml(result.sourceId)}</b>: ${previous} → <b>${result.verdict}</b>` +
        ` (HTTP ${result.httpStatus}, ${escapeHtml(result.antibotVendor)})` +
        (result.notes ? `\n  ${escapeHtml(result.notes)}` : ''),
    );

    await this.notifier.alert(
      await this.alertRecipients(),
      `⚠️ <b>Source policy degraded</b>\nprobed from <code>${escapeHtml(this.probedFrom)}</code>\n\n${lines.join('\n')}`,
    );
  }

  /**
   * Operational alerts go to the deployment's chat ids when configured, because who gets told the
   * monitor is in trouble is deployment configuration rather than anyone's search preference. The
   * profiles are the fallback so a partly-configured install still gets told.
   */
  private async alertRecipients(): Promise<string[]> {
    const configured = loadEnv().TELEGRAM_CHAT_IDS;
    if (configured && configured.length > 0) return configured;
    const profiles = await this.profilesService.findActive();
    return [...new Set(profiles.flatMap((p) => p.notify.telegramChatIds))];
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
