import { useEffect, useState, type ReactElement } from 'react';
import type { FeedPage, ProfileSummary, SortKey } from '@shared/api-types';
import { STATUS_LABEL, money, plural, sourceLabel, titleCase } from '../lib/labels';
import { useMediaQuery } from '../lib/useMediaQuery';
import { DEFAULT_FILTERS, activeFilterCount, type FilterState, type StatusFilter } from '../state/useFilters';

interface Props {
  profile: ProfileSummary;
  filters: FilterState;
  facets: FeedPage['facets'] | null;
  total: number | null;
  onChange: (patch: Partial<FilterState>) => void;
}

const SORT_LABEL: Record<SortKey, string> = {
  score: 'score',
  rent: 'preço',
  newest: 'mais recente',
  posted: 'publicação',
  area: 'área',
};

const STATUSES: StatusFilter[] = ['favourite', 'contacted', 'dismissed'];

/** Dragging the slider fires continuously; the request goes out once the thumb has rested. */
const SLIDER_SETTLE_MS = 350;

export function FilterBar({ profile, filters, facets, total, onChange }: Props): ReactElement {
  const wide = useMediaQuery('(min-width: 1024px)');
  // Open where there is room and the list is showing; the map wants the height, so it starts folded.
  const [open, setOpen] = useState(wide && filters.view !== 'map');
  useEffect(() => setOpen(wide && filters.view !== 'map'), [wide, filters.view]);

  const committedScore = filters.minScore ?? profile.minScore;
  const [score, setScore] = useState(committedScore);
  useEffect(() => setScore(committedScore), [committedScore]);
  useEffect(() => {
    if (score === committedScore) return;
    const timer = setTimeout(() => onChange({ minScore: score === profile.minScore ? null : score }), SLIDER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [score, committedScore, profile.minScore, onChange]);

  const [rent, setRent] = useState(filters.maxRent?.toString() ?? '');
  useEffect(() => setRent(filters.maxRent?.toString() ?? ''), [filters.maxRent]);
  const commitRent = (): void => {
    const n = Number(rent);
    const next = rent.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
    if (next !== filters.maxRent) onChange({ maxRent: next });
  };

  const toggleSource = (s: string): void =>
    onChange({ source: filters.source.includes(s) ? filters.source.filter((x) => x !== s) : [...filters.source, s] });

  const sources = facets?.sources ?? [];
  const cities = facets?.cities ?? [];
  const areas = facets?.areas ?? [];
  const active = activeFilterCount(filters);

  return (
    <details className="filters" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span>Filtros{active > 0 ? ` (${active})` : ''}</span>
        <span className="muted">{total !== null ? `${total} ${plural(total, 'anúncio', 'anúncios')}` : ''}</span>
      </summary>
      <div className="filters-body">
        <label className="field">
          <span>
            Score mínimo: <strong>{score}</strong>
            {score === profile.minScore && <span className="muted"> (corte do perfil)</span>}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={score}
            onChange={(e) => setScore(Number(e.target.value))}
            list="score-ticks"
            aria-label="Score mínimo"
          />
          <datalist id="score-ticks">
            <option value={profile.minScore} label={String(profile.minScore)} />
          </datalist>
        </label>

        <div className="field-row">
          <label className="field">
            <span>Aluguel máx. (CAD/mês)</span>
            <input
              type="number"
              inputMode="numeric"
              step={50}
              min={0}
              placeholder={`até ${money(profile.totalRentMax)}`}
              value={rent}
              onChange={(e) => setRent(e.target.value)}
              onBlur={commitRent}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRent();
                }
              }}
            />
          </label>
          <label className="field">
            <span>Ordenar por</span>
            <select value={filters.sort} onChange={(e) => onChange({ sort: e.target.value as SortKey })}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {profile.bedroomTiers.length > 0 && (
          <div className="chips" role="group" aria-label="Quartos">
            {profile.bedroomTiers.map((t, i) => (
              <button
                key={t.label}
                type="button"
                className={`chip clickable${filters.tier === i ? ' on' : ''}`}
                aria-pressed={filters.tier === i}
                onClick={() => onChange({ tier: filters.tier === i ? null : i })}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="field-row">
          <label className="field">
            <span>Cidade</span>
            <select value={filters.city ?? ''} onChange={(e) => onChange({ city: e.target.value || null })}>
              <option value="">todas</option>
              {cities.map((c) => (
                <option key={c.value} value={c.value}>
                  {titleCase(c.value)} ({c.count})
                </option>
              ))}
              {filters.city && !cities.some((c) => c.value === filters.city) && (
                <option value={filters.city}>{titleCase(filters.city)}</option>
              )}
            </select>
          </label>
          <label className="field">
            <span>Área</span>
            <select value={filters.area ?? ''} onChange={(e) => onChange({ area: e.target.value || null })}>
              <option value="">todas</option>
              {areas.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.value} ({a.count})
                </option>
              ))}
              {filters.area && !areas.some((a) => a.value === filters.area) && <option value={filters.area}>{filters.area}</option>}
            </select>
          </label>
        </div>

        {sources.length > 0 && (
          <div className="chips" role="group" aria-label="Fontes">
            {sources.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`chip clickable${filters.source.includes(s.value) ? ' on' : ''}`}
                aria-pressed={filters.source.includes(s.value)}
                onClick={() => toggleSource(s.value)}
              >
                {sourceLabel(s.value)} <span className="muted">{s.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="chips" role="group" aria-label="Estado">
          {STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              className={`chip clickable${filters.status === st ? ' on' : ''}`}
              aria-pressed={filters.status === st}
              onClick={() => onChange({ status: filters.status === st ? null : st })}
            >
              {st === 'favourite' ? '★ ' : st === 'contacted' ? '✓ ' : '✕ '}
              {STATUS_LABEL[st]}
            </button>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={filters.includeDelisted}
              onChange={(e) => onChange({ includeDelisted: e.target.checked })}
            />
            mostrar removidos
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.includeDismissed}
              onChange={(e) => onChange({ includeDismissed: e.target.checked })}
            />
            mostrar descartados
          </label>
          {active > 0 && (
            <button type="button" className="btn link" onClick={() => onChange({ ...DEFAULT_FILTERS, view: filters.view })}>
              limpar filtros
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
