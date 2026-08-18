import { SCORE_COMPONENTS } from './components';
import type { ScoringContext } from './context';

export interface ScoreResult {
  score: number;
  /**
   * Points each component contributed to the final 0..100. Mandatory output: weights
   * cannot be calibrated from a bare score, and calibrating weights is most of the value
   * of this system in the first weeks.
   */
  breakdown: Record<string, number>;
  /** Raw 0..1 component values, before weighting. Useful when reading a breakdown back. */
  rawComponents: Record<string, number>;
  /** Components that could not be evaluated, and were therefore excluded from the average. */
  skipped: string[];
}

export class UnknownComponentError extends Error {
  constructor(names: string[]) {
    super(
      `Profile weights reference unknown scoring components: ${names.join(', ')}. ` +
        `Known components: ${Object.keys(SCORE_COMPONENTS).join(', ')}.`,
    );
    this.name = 'UnknownComponentError';
  }
}

/**
 * score = sum(component x weight) / sum(weights of components that were evaluated) x 100
 *
 * Weights need not sum to 100. Components returning null are dropped from numerator and
 * denominator alike, so a listing with unknown locker status is scored on what is known
 * rather than penalised for the gap.
 */
export function scoreListing(ctx: ScoringContext): ScoreResult {
  const weights = ctx.profile.soft.weights;

  const unknown = Object.keys(weights).filter((name) => !(name in SCORE_COMPONENTS));
  if (unknown.length > 0) {
    // Fail loudly. A typo in a weight key would otherwise silently drop a criterion.
    throw new UnknownComponentError(unknown);
  }

  const breakdown: Record<string, number> = {};
  const rawComponents: Record<string, number> = {};
  const skipped: string[] = [];

  let weightedSum = 0;
  let effectiveWeight = 0;

  for (const [name, weight] of Object.entries(weights)) {
    if (weight <= 0) continue;
    const component = SCORE_COMPONENTS[name];
    if (!component) continue;

    const value = component(ctx);
    if (value === null) {
      skipped.push(name);
      continue;
    }

    rawComponents[name] = value;
    weightedSum += value * weight;
    effectiveWeight += weight;
  }

  const score = effectiveWeight === 0 ? 0 : (weightedSum / effectiveWeight) * 100;

  // Second pass so each contribution is expressed in final points and the parts sum to the whole.
  for (const [name, value] of Object.entries(rawComponents)) {
    const weight = weights[name] ?? 0;
    breakdown[name] = round2((value * weight) / effectiveWeight * 100);
  }

  return { score: round2(score), breakdown, rawComponents, skipped };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
