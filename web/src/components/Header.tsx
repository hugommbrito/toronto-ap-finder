import type { ReactElement } from 'react';
import type { ProfileSummary, Summary } from '@shared/api-types';
import { minutesAgo } from '../lib/format';
import { sourceLabel } from '../lib/labels';
import { toHash, type Route } from '../routing/useHashRoute';

interface Props {
  profile: ProfileSummary;
  profiles: ProfileSummary[];
  summary: Summary | null;
  route: Route;
  query: URLSearchParams;
  onProfile: (id: string) => void;
  onLogout: () => void;
}

/** Two hours: the scheduler runs every 15–35 minutes, so a gap this long is a stall, not jitter. */
const STALE_AFTER_MIN = 120;

export function Header({ profile, profiles, summary, route, query, onProfile, onLogout }: Props): ReactElement {
  const s = summary;
  const stale = s?.minutesSinceLastCycle !== null && s?.minutesSinceLastCycle !== undefined && s.minutesSinceLastCycle > STALE_AFTER_MIN;

  return (
    <header className="topbar">
      <div className="topbar-row">
        <a className="brand" href={toHash({ name: 'feed' }, query)}>
          🏠 Anúncios
        </a>
        {profiles.length > 1 ? (
          <select className="select" value={profile.id} onChange={(e) => onProfile(e.target.value)} aria-label="Perfil">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted profile-label" title={profile.label}>
            {profile.label}
          </span>
        )}
        <nav className="topnav" aria-label="Seções">
          <a className={route.name !== 'ops' ? 'active' : ''} href={toHash({ name: 'feed' }, query)}>
            Anúncios
          </a>
          <a className={route.name === 'ops' ? 'active' : ''} href={toHash({ name: 'ops' }, query)}>
            Funil
          </a>
          <button type="button" className="btn link" onClick={onLogout}>
            Sair
          </button>
        </nav>
      </div>
      <div className="topbar-row freshness">
        {s ? (
          <>
            <span className={stale ? 'warn' : ''}>
              {s.lastCycleAt ? `Último ciclo ${minutesAgo(s.minutesSinceLastCycle ?? 0, s.lastCycleAt)}` : 'Nenhum ciclo ainda'}
            </span>
            {s.pausedSources.length > 0 && <span className="warn">⚠ pausada: {s.pausedSources.map(sourceLabel).join(', ')}</span>}
            <span className="chip" title="Anúncios ativos com score acima do corte do perfil">
              {s.counts.aboveMinScore} acima de {profile.minScore}
            </span>
            <span className="chip">{s.counts.newSince24h} novos em 24 h</span>
            <span className="chip" title="Favoritos">
              ★ {s.counts.favourites}
            </span>
            <span className="chip" title="Contatados">
              ✓ {s.counts.contacted}
            </span>
            <span className="chip muted" title="Tudo que já recebeu score, inclusive removidos e descartados">
              {s.counts.scored} pontuados
            </span>
          </>
        ) : (
          <span className="muted">…</span>
        )}
      </div>
    </header>
  );
}
