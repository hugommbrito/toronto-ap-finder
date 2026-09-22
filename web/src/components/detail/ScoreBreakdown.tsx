import type { ReactElement } from 'react';
import { breakdownBars } from '../../lib/breakdown';
import { componentLabel } from '../../lib/labels';

interface Props {
  weights: Record<string, number>;
  breakdown: Record<string, number>;
  score: number;
}

/**
 * The instrument for calibrating the weights: each criterion's points against the most it could
 * have given, heaviest first, and — separately — the criteria the ad gave no way to evaluate.
 * Collapsed by default; the reader who wants it knows where it is.
 */
export function ScoreBreakdown({ weights, breakdown, score }: Props): ReactElement {
  const view = breakdownBars(weights, breakdown);
  return (
    <details className="breakdown">
      <summary>
        Como o score foi calculado{' '}
        <span className="muted">
          — {score.toFixed(1)} pontos, {view.bars.length} critérios avaliados
          {view.skipped.length > 0 ? `, ${view.skipped.length} não ${view.skipped.length === 1 ? 'avaliado' : 'avaliados'}` : ''}
        </span>
      </summary>
      <ol className="bars plain">
        {view.bars.map((b) => (
          <li key={b.name}>
            <span className="bar-label">{componentLabel(b.name)}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${(b.ratio * 100).toFixed(1)}%` }} />
            </span>
            <span className="bar-value">
              {b.points.toFixed(1)} <span className="muted">/ {b.maxPoints.toFixed(1)}</span>
            </span>
          </li>
        ))}
        {view.skipped.map((name) => (
          <li key={name} className="skipped">
            <span className="bar-label">{componentLabel(name)}</span>
            <span className="bar-track" />
            <span className="bar-value muted">não avaliado</span>
          </li>
        ))}
      </ol>
      <p className="muted small">
        Cada critério vale no máximo <em>peso ÷ soma dos pesos avaliados × 100</em>. Um critério que o anúncio não
        permite avaliar sai da conta em vez de valer zero — por isso o denominador deste anúncio é{' '}
        {view.effectiveWeight}, não a soma de todos os pesos.
      </p>
    </details>
  );
}
