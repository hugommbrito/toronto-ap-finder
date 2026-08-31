import {
  clamp01,
  linearDecay,
  type NearbyDaycare,
  type ScoreComponent,
  type ScoringContext,
} from '../context';
import { daycareCoverageOf } from '@/geo/coverage';
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

/**
 * How much credit a region's data can actually earn.
 *
 * Peel and Waterloo publish where licensed centres are and nothing about who they are
 * licensed for, so "a centre 200 m away" is a weaker claim there than the same sentence about
 * Toronto, where it means 200 m to a centre with **toddler places**. Paying both in full would
 * quietly rank an unverified centre above a verified one.
 *
 * Nulling the components instead was the obvious alternative and is worse. A null drops out of
 * the denominator, so the score renormalises over what is left — here `bedroomFit` (35) and
 * `rentBelowTarget` (30), which is exactly the axis where the 905 wins on price. That would
 * systematically promote the listings we know *least* about. Same bias `buildingScore` reasons
 * through below, running in the other direction.
 *
 * So: half credit, kept in the denominator. A presence-only listing can still beat a Toronto
 * one, but it has to do it on rent and layout rather than on childcare it was never shown to have.
 */
const PRESENCE_ONLY_CONFIDENCE = 0.5;

interface DaycareLookup {
  nearby: NearbyDaycare[];
  /** Multiplier on any credit earned. 1 where capacity per age group is published. */
  confidence: number;
  /**
   * Carried explicitly rather than inferred from `confidence !== 1`.
   *
   * Affordability has to abstain where capacity is unpublished, and reading that off the
   * multiplier couples the two: tuning PRESENCE_ONLY_CONFIDENCE to 1 would silently start
   * scoring CWELCC for regions that publish none of it.
   */
  capacityPublished: boolean;
}

/**
 * Resolves the nearby set against whatever the region actually publishes.
 *
 * Returns null — "cannot know" — when there are no coordinates, when the profile asked for no
 * daycare filter, or when no dataset covers the city at all. That last case is the one worth
 * naming: a region we have no data for must not score 0, because 0 is a claim.
 */
function daycareLookup(ctx: ScoringContext): DaycareLookup | null {
  const from = origin(ctx);
  const cfg = daycareConfig(ctx);
  if (!from || !cfg) return null;

  // The city decides only whether *any* data reaches here. What it cannot decide is how good
  // the data is, because a region's centres do not stop at its border — see hard-filters.ts.
  if (daycareCoverageOf(ctx.listing.city) === 'none') return null;

  const nearby = ctx.geo.daycaresWithin(from, cfg.radiusM, cfg.ageGroup, {
    acceptUnknownCapacity: true,
  });
  /**
   * Discounted only if the credit actually rests on unpublished capacity.
   *
   * Keyed on the counted set rather than on the listing's region: a Mississauga address whose one
   * centre in range is a Toronto row with a published toddler place has nothing uncertain about
   * it, and halving its score — as keying on the region did — penalised it for its postcode.
   */
  const capacityPublished = nearby.every((n) => n.daycare.capacityKnown);
  return {
    nearby,
    confidence: capacityPublished ? 1 : PRESENCE_ONLY_CONFIDENCE,
    capacityPublished,
  };
}

/** 1.0 at the same address, decaying linearly to 0 at the profile's radius. */
export const daycareProximity: ScoreComponent = (ctx) => {
  const cfg = daycareConfig(ctx);
  const found = daycareLookup(ctx);
  if (!cfg || !found) return null;

  const nearest = found.nearby[0];
  if (!nearest) return 0;
  return found.confidence * linearDecay(nearest.distanceM, 0, cfg.radiusM);
};

/**
 * Redundancy outranks the single nearest centre. Toronto wait-lists are long, so one
 * daycare 200 m away is not a guaranteed place; four within walking distance is.
 */
export const daycareRedundancy: ScoreComponent = (ctx) => {
  const found = daycareLookup(ctx);
  if (!found) return null;

  return found.confidence * clamp01(found.nearby.length / DAYCARE_REDUNDANCY_TARGET);
};

/**
 * How cheap the reachable childcare is, which for a budget-driven search is worth more
 * than a few hundred metres. A CWELCC place ($10/day) against private market rates is a
 * CAD 800-1200/month difference — larger than the gap between two listings in this band.
 */
export const daycareAffordability: ScoreComponent = (ctx) => {
  const found = daycareLookup(ctx);
  if (!found) return null;

  /**
   * Unlike proximity, this one cannot be discounted — it has to abstain.
   *
   * A haircut works where the underlying measurement is real and its *relevance* is uncertain:
   * the distance to a Peel centre is a true distance. Here the measurement itself is missing.
   * Neither Peel nor Waterloo publishes CWELCC, so `cwelcc` is false for every row of those
   * regions — false meaning "unstated", not "does not participate". Scoring that would report
   * the whole 905 as having no $10/day childcare, which is not something anyone measured.
   */
  if (!found.capacityPublished) return null;

  const nearby = found.nearby;
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

/**
 * The floor area curve is anchored on the apartment she lives in now: 950 sq ft.
 *
 * Her own words define both ends. A 3BR smaller than today's place is not worth the move —
 * below 800 even three nominal bedrooms don't hold two working adults and a child. A 2BR+den
 * larger than today's place already is worth it — by 1,100 the den is a real office and the
 * living space breathes. Linear between the two, so 950 itself sits at exactly 0.5: the move
 * has to buy space, not merely match it.
 *
 * At weight 15 this is deliberately strong enough to cross layouts: a 1,100 sq ft 2BR+den
 * outranks an 850 sq ft 3BR (24.5 + 15 beats 35 + 2.5 in weight units), which is precisely
 * the trade she described. Null when the ad never states the area — that listing competes on
 * what is known about it, unpunished, like every other tri-state.
 */
const AREA_ZERO_SQFT = 800;
const AREA_FULL_SQFT = 1100;

export const areaFit: ScoreComponent = (ctx) => {
  const sqft = ctx.listing.areaSqft;
  if (sqft === null) return null;
  return clamp01((sqft - AREA_ZERO_SQFT) / (AREA_FULL_SQFT - AREA_ZERO_SQFT));
};

/**
 * What the ad says about somewhere to put the car — the distinctions the hard filter's pass
 * cannot rank. `requireParking` already guarantees anything scored either includes parking,
 * prices it, or offers it on unstated terms; this pays the difference between those three.
 * Included in the rent is full credit. A spot at a price and a spot on unstated terms both
 * earn half: a real spot either way, but not a free one — and the priced one's cost is
 * already counted against the listing in totalMonthlyCost. Explicit "no parking" scores 0,
 * which only matters for profiles that don't require parking; silence stays null and drops
 * out of the denominator like every other tri-state.
 */
export const parkingConfirmed: ScoreComponent = (ctx) => {
  const { parkingIncluded, parkingCost, parkingAvailable } = ctx.listing;
  if (parkingIncluded === true) return 1;
  // Before the false-check on purpose: "not included, but $150/month" is a purchasable spot.
  if (parkingCost !== null) return 0.5;
  if (parkingAvailable === true) return 0.5;
  if (parkingIncluded === false) return 0;
  return null;
};

/**
 * Two working adults and a child. One bathroom is the baseline (0), a powder room is half a
 * step, a second full bath is full credit — beyond two adds nothing a family of three uses.
 */
export const bathrooms: ScoreComponent = (ctx) =>
  ctx.listing.baths === null ? null : clamp01(ctx.listing.baths - 1);

/**
 * The score a typical inspected building carries — the point where this component is neutral.
 *
 * Four numbers are in play and they are not interchangeable, which is why this one is 91:
 *
 * | 88    | the City's published municipal average |
 * | 88.62 | the mean over all 6,090 **evaluations** |
 * | 89.76 | the mean over the 3,585 **buildings**, after keeping each one's latest evaluation |
 * | 91    | the **median** of those buildings |
 *
 * This component scores a building, so the population is the deduplicated buildings and not the
 * evaluation rows — the two differ because a building that is flagged tends to score better next
 * time, so later evaluations run high. Anchoring on 88 would have handed 0.573 to a typical
 * building instead of 0.5, biasing in exactly the direction the curve exists to avoid.
 *
 * The median rather than the mean, because it makes the claim exact: half of all inspected
 * buildings score above this and half below, so half are rewarded and half are penalised. It is
 * also unmoved by the tail — the worst building in the file scores 17.
 *
 * The seed prints the observed mean and median on every run, because a constant nobody re-checks
 * against the data is a constant that quietly stops being true.
 */
const TYPICAL_BUILDING_SCORE = 91;
/** The City's own red line: at or below this a building is audited. Only 0.4% of stock. */
const AUDIT_FLOOR_SCORE = 50;

/**
 * How the building itself scored when the City inspected it — a signal no aggregator offers.
 *
 * **An average building is neutral, not good.** The obvious mapping, `score / 100`, hands 0.88 to
 * a building that is merely typical, and coverage makes that a systematic bias rather than a
 * rounding error: measured, 90% of purpose-built units match an inspected building against about
 * 15% of condo listings. Since a null component drops out of the average entirely, paying 0.88 to
 * everything that matches would quietly promote the whole purpose-built segment over condos on a
 * criterion condos cannot have. That is the bias the addendum warns about, arriving through the
 * other door.
 *
 * So the curve is a two-segment hinge on the typical building, in the same spirit as
 * rentBelowTarget: 91 → 0.50, 100 → 1.00, 50 → 0.00. The floor sits at the City's audit line
 * rather than at zero because a ramp to zero-at-zero would compress the populated band (74–100,
 * p05 to max) into the top quarter of the range and recreate the flatness it was meant to fix.
 * The upper segment is the steeper of the two on purpose: a quarter of all inspected buildings
 * score 95 or better, so that is where the discrimination has to happen.
 *
 * One honest qualifier, because renormalisation makes it counter-intuitive: a component pulls the
 * final score *towards its own value*, so "neutral" holds in the component's units and not in
 * final points. Break-even against an unmatched condo sits at `value = score/100`, so a listing
 * scoring 75 on everything else needs a building around 96 before the match pays. A merely typical
 * building therefore costs a strong listing a couple of points. That is a bounded, two-sided
 * residual instead of a one-directional subsidy, which is the whole purpose.
 */
export const buildingScore: ScoreComponent = (ctx) => {
  const raw = ctx.building?.score;
  if (raw === undefined || raw === null) return null;

  return raw >= TYPICAL_BUILDING_SCORE
    ? clamp01(0.5 + (0.5 * (raw - TYPICAL_BUILDING_SCORE)) / (100 - TYPICAL_BUILDING_SCORE))
    : clamp01((0.5 * (raw - AUDIT_FLOOR_SCORE)) / (TYPICAL_BUILDING_SCORE - AUDIT_FLOOR_SCORE));
};

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
  areaFit,
  bathrooms,
  daycareProximity,
  daycareRedundancy,
  daycareAffordability,
  transitOperational,
  transitFuture,
  parkingConfirmed,
  locker,
  inSuiteLaundry,
  rentControlled,
  rentBelowTarget,
  buildingScore,
};

export type ComponentName = keyof typeof SCORE_COMPONENTS;
