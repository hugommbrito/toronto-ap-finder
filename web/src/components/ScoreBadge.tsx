import type { ReactElement } from 'react';
import { scoreBand } from '../lib/labels';

/** Green at or above the profile's bar, amber within ten points of it, grey below that. */
export function ScoreBadge({ score, minScore, large = false }: { score: number; minScore: number; large?: boolean }): ReactElement {
  const band = scoreBand(score, minScore);
  return (
    <div className={`score score-${band}${large ? ' score-lg' : ''}`} title={`score ${score.toFixed(1)} · corte ${minScore}`}>
      {Math.round(score)}
    </div>
  );
}
