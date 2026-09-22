import type { ReactElement } from 'react';

/** Green at or above the profile's bar, amber within ten points of it, grey below that. */
export function ScoreBadge({ score, minScore, large = false }: { score: number; minScore: number; large?: boolean }): ReactElement {
  const band = score >= minScore ? 'good' : score >= minScore - 10 ? 'near' : 'low';
  return (
    <div className={`score score-${band}${large ? ' score-lg' : ''}`} title={`score ${score.toFixed(1)} · corte ${minScore}`}>
      {Math.round(score)}
    </div>
  );
}
