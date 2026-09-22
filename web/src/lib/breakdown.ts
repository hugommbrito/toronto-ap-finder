export interface BreakdownBar {
  name: string;
  points: number;
  maxPoints: number;
  /** points / maxPoints, clamped to 0..1 — the fill of the bar. */
  ratio: number;
}

export interface BreakdownView {
  /** Heaviest criterion first, so two listings' breakdowns line up row for row. */
  bars: BreakdownBar[];
  /** Weighted components with no entry: they returned null and left the denominator. */
  skipped: string[];
  effectiveWeight: number;
  /** Σ points — equals the score within rounding, which is the check that this is right. */
  total: number;
}

/**
 * Mirrors scorer.ts: a component's final points are value × weight / Σ(weights that evaluated) × 100.
 * So the most it could have contributed is weight / effectiveWeight × 100, and the parts sum to
 * the score. Nothing here is a heuristic; it is the scorer's arithmetic run backwards.
 */
export function breakdownBars(weights: Record<string, number>, breakdown: Record<string, number>): BreakdownView {
  const evaluated = Object.keys(breakdown).filter((name) => (weights[name] ?? 0) > 0);
  const effectiveWeight = evaluated.reduce((sum, name) => sum + (weights[name] ?? 0), 0);

  const bars = evaluated
    .map((name) => {
      const maxPoints = effectiveWeight > 0 ? ((weights[name] ?? 0) / effectiveWeight) * 100 : 0;
      const points = breakdown[name] ?? 0;
      const ratio = maxPoints > 0 ? Math.min(1, Math.max(0, points / maxPoints)) : 0;
      return { name, points, maxPoints, ratio };
    })
    .sort((a, b) => b.maxPoints - a.maxPoints || a.name.localeCompare(b.name));

  const skipped = Object.entries(weights)
    .filter(([name, weight]) => weight > 0 && !(name in breakdown))
    .map(([name]) => name)
    .sort();

  return { bars, skipped, effectiveWeight, total: bars.reduce((sum, b) => sum + b.points, 0) };
}
