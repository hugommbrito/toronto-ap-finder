/**
 * The subset of RFC 9309 this project actually needs, and no more.
 *
 * Until now robots.txt was a human process: someone read the file, wrote the conclusion into
 * `docs/sources/<id>.md`, and encoded it in a URL builder that tests assert can never emit a
 * disallowed form. That is a good arrangement — enforcement by construction beats enforcement by
 * runtime check — but it goes stale silently, because nothing re-reads the file. This module is
 * what re-reads it, weekly, and says so when the answer changes.
 *
 * It deliberately does **not** gate any fetch. The URL builders remain the enforcement; this is
 * the alarm.
 */

export type RobotsVerdict = 'allow' | 'disallow' | 'absent';

export interface RobotsRule {
  kind: 'allow' | 'disallow';
  pattern: string;
}

export interface RobotsRules {
  /** Only the rules of the group that binds us, after group selection. */
  rules: RobotsRule[];
  crawlDelayMs: number | null;
  /** Which `user-agent` group was selected — the first thing a source doc should record. */
  group: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

/** No group matched, so nothing is disallowed. */
export const NO_RULES: RobotsRules = { rules: [], crawlDelayMs: null, group: 'none' };

/**
 * Groups are runs of consecutive `user-agent` lines followed by their rules. A rule line ends
 * the run, so the next `user-agent` after a rule opens a new group rather than joining the
 * previous one.
 */
function parseGroups(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents || current === null) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    collectingAgents = false;
    // A rule before any user-agent line belongs to no group and binds nobody.
    if (current === null) continue;

    if (field === 'disallow') current.rules.push({ kind: 'disallow', pattern: value });
    else if (field === 'allow') current.rules.push({ kind: 'allow', pattern: value });
    else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
    }
  }

  return groups;
}

/**
 * Most specific group wins: a group naming our own product token beats the wildcard.
 *
 * This is why an honest User-Agent has a practical consequence and not only an ethical one — a
 * site that wants to give us narrower or wider rules than the wildcard can, and we will see them.
 */
export function parseRobots(body: string, productToken: string): RobotsRules {
  const groups = parseGroups(body);
  const token = productToken.toLowerCase();

  const specific = groups.find((g) =>
    g.agents.some((agent) => agent !== '*' && agent !== '' && token.startsWith(agent)),
  );
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = specific ?? wildcard;
  if (!chosen) return NO_RULES;

  return {
    rules: chosen.rules,
    crawlDelayMs: chosen.crawlDelaySeconds === null ? null : Math.round(chosen.crawlDelaySeconds * 1000),
    group: specific ? chosen.agents.join(', ') : '*',
  };
}

/** `*` matches any run of characters; a trailing `$` anchors the end. Everything else is literal. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Longest matching pattern wins, and `Allow` wins a tie.
 *
 * `target` is the path plus query string, which matters here: Kijiji's rules disallow the
 * query-string search filters specifically, so a path-only check would report every one of them
 * as permitted.
 */
export function isAllowed(rules: RobotsRules, target: string): boolean {
  let best: { kind: 'allow' | 'disallow'; length: number } | null = null;

  for (const rule of rules.rules) {
    // `Disallow:` with an empty value means "nothing is disallowed" — it matches nothing.
    if (rule.pattern === '') continue;
    if (!patternToRegExp(rule.pattern).test(target)) continue;

    const longer = best === null || rule.pattern.length > best.length;
    const tieToAllow = best !== null && rule.pattern.length === best.length && rule.kind === 'allow';
    if (longer || tieToAllow) best = { kind: rule.kind, length: rule.pattern.length };
  }

  return best === null || best.kind === 'allow';
}

/** Path plus query, which is what the rules are written against. */
export function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
