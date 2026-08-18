import { clamp01, linearDecay, type ScoreComponent, type ScoringContext } from '../context';
import { evaluateBedroomRule } from '../bedroom-rule';

const DEFAULT_DAYCARE_RADIUS_M = 800;
/** Redundancy saturates here: four reachable centres is enough insurance against wait-lists. */
const DAYCARE_REDUNDANCY_TARGET = 4;
/** Below this a station is "at the door" and extra closeness buys nothing. */
const TRANSIT_FULL_CREDIT_M = 400;
const DEFAULT_MAX_TRANSIT_WALK_M = 900;

function origin(ctx: ScoringContext): { lat: number; lng: number } | null {
  const { lat, lng } = ctx.listing;
  return lat === null || lng === null ? null : { lat, lng };
}

function daycareConfig(ctx: ScoringContext): { radiusM: number; ageGroup: 'infant' | 'toddler' | 'preschool' | 'kindergarten' | 'schoolage' } | null {
  const cfg = ctx.profile.hard.minDaycaresWithin;
  if (!cfg) return null;
  return { radiusM: cfg.radiusM || DEFAULT_DAYCARE_RADIUS_M, ageGroup: cfg.ageGroup };
}

/** 1.0 at the same address, decaying linearly to 0 at the profile's radius. */
export const daycareProximity: ScoreComponent = (ctx) => {
  const from = origin(ctx);
  const cfg = daycareConfig(ctx);
  if (!from || !cfg) return null;

  const nearby = ctx.geo.daycaresWithin(from, cfg.radiusM, cfg.ageGroup);
  const nearest = nearby[0];
  if (!nearest) return 0;
  return linearDecay(nearest.distanceM, 0, cfg.radiusM);
};

/**
 * Redundancy outranks the single nearest centre. Toronto wait-lists are long, so one
 * daycare 200 m away is not a guaranteed place; four within walking distance is.
 */
export const daycareRedundancy: ScoreComponent = (ctx) => {
  const from = origin(ctx);
  const cfg = daycareConfig(ctx);
  if (!from || !cfg) return null;

  const count = ctx.geo.daycaresWithin(from, cfg.radiusM, cfg.ageGroup).length;
  return clamp01(count / DAYCARE_REDUNDANCY_TARGET);
};

/**
 * How cheap the reachable childcare is, which for a budget-driven search is worth more
 * than a few hundred metres. A CWELCC place ($10/day) against private market rates is a
 * CAD 800-1200/month difference — larger than the gap between two listings in this band.
 */
export const daycareAffordability: ScoreComponent = (ctx) => {
  const from = origin(ctx);
  const cfg = daycareConfig(ctx);
  if (!from || !cfg) return null;

  const nearby = ctx.geo.daycaresWithin(from, cfg.radiusM, cfg.ageGroup);
  if (nearby.length === 0) return 0;

  const cwelccCount = nearby.filter((n) => n.daycare.cwelcc).length;
  const subsidyCount = nearby.filter((n) => n.daycare.subsidy).length;

  // Two CWELCC centres carry most of the weight; municipal subsidy is a weaker second signal.
  return clamp01(0.7 * Math.min(cwelccCount / 2, 1) + 0.3 * Math.min(subsidyCount / 3, 1));
};

/**
 * Where the transit score reaches zero.
 *
 * Prefers the soft setting so that a profile can score distance without eliminating on it —
 * a listing 971 m from a station and one 899 m away differ by about a minute of walking,
 * and only one of those should not be a cliff. Falls back to the hard limit for profiles
 * that do want a cut-off.
 */
function transitZeroAt(ctx: ScoringContext): number {
  return ctx.profile.soft.transitWalkZeroM ?? ctx.profile.hard.maxTransitWalkM ?? DEFAULT_MAX_TRANSIT_WALK_M;
}

export const transitOperational: ScoreComponent = (ctx) => {
  const from = origin(ctx);
  if (!from) return null;

  const nearest = ctx.geo.nearestStation(from, 'operational');
  if (!nearest) return 0;
  return linearDecay(nearest.distanceM, TRANSIT_FULL_CREDIT_M, transitZeroAt(ctx));
};

/**
 * Same curve as operational, but carries a deliberately small weight. A 2031 line must
 * never be able to compensate for the absence of one that exists today.
 */
export const transitFuture: ScoreComponent = (ctx) => {
  const from = origin(ctx);
  if (!from) return null;

  const nearest = ctx.geo.nearestStation(from, 'future');
  if (!nearest) return 0;
  return linearDecay(nearest.distanceM, TRANSIT_FULL_CREDIT_M, transitZeroAt(ctx));
};

export const locker: ScoreComponent = (ctx) =>
  ctx.listing.hasLocker === null ? null : ctx.listing.hasLocker ? 1 : 0;

export const inSuiteLaundry: ScoreComponent = (ctx) =>
  ctx.listing.inSuiteLaundry === null ? null : ctx.listing.inSuiteLaundry ? 1 : 0;

export const rentControlled: ScoreComponent = (ctx) =>
  ctx.listing.buildingBuiltBefore2018 === null ? null : ctx.listing.buildingBuiltBefore2018 ? 1 : 0;

/**
 * Two-sided curve, and the reason matters.
 *
 * The obvious formula — (target - total) / target — returns 0 for everything above the
 * target, which in this market is everything. That would leave the single most important
 * axis of the search with no power to discriminate between a listing at 2,750 and one at
 * 3,150. Instead: full credit at or below target, decaying to zero at the profile's
 * ceiling, so overshooting the budget lowers the ranking rather than ending the search.
 */
export const rentBelowTarget: ScoreComponent = (ctx) => {
  const target = ctx.profile.soft.targetRent;
  if (target === undefined) return null;

  const ceiling = ctx.profile.hard.totalRentMax;
  const total = ctx.listing.totalMonthlyCost;

  if (total <= target) return 1;
  if (ceiling <= target) return 0;
  return clamp01((ceiling - total) / (ceiling - target));
};

/**
 * How well the unit's layout fits, on the profile's own ladder rather than as a threshold.
 *
 * Tiers are walked in order and the first match wins, so the ladder must be declared
 * strictest-first — a 3BR also satisfies `min: 2`. The same recursive evaluator used by the
 * hard filter does the matching, so a tier can be any rule shape the profile can express.
 *
 * Returns null when the bedroom count is unknown: that is a listing to look at by hand, not
 * a studio.
 */
export const bedroomFit: ScoreComponent = (ctx) => {
  const tiers = ctx.profile.soft.bedroomTiers;
  if (!tiers || tiers.length === 0) return null;

  const layout = { beds: ctx.listing.beds, dens: ctx.listing.dens };
  let indeterminate = false;

  for (const tier of tiers) {
    const matched = evaluateBedroomRule(tier.rule, layout);
    if (matched === true) return clamp01(tier.value);
    if (matched === null) indeterminate = true;
  }

  // Nothing matched, and the reason might be that we never knew the layout.
  return indeterminate ? null : 0;
};

/**
 * The registry is the extension point. A new criterion is a function here plus a key in
 * the profile's weights jsonb — never a branch on a profile id.
 */
export const SCORE_COMPONENTS: Record<string, ScoreComponent> = {
  bedroomFit,
  daycareProximity,
  daycareRedundancy,
  daycareAffordability,
  transitOperational,
  transitFuture,
  locker,
  inSuiteLaundry,
  rentControlled,
  rentBelowTarget,
};

export type ComponentName = keyof typeof SCORE_COMPONENTS;
