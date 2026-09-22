import { useCallback } from 'react';
import type { SortKey } from '@shared/api-types';
import { navigate, type Route } from '../routing/useHashRoute';

export type StatusFilter = 'favourite' | 'contacted' | 'dismissed';

export interface FilterState {
  /** Null means the profile's own minScore. */
  minScore: number | null;
  maxRent: number | null;
  tier: number | null;
  city: string | null;
  area: string | null;
  source: string[];
  sort: SortKey;
  includeDelisted: boolean;
  includeDismissed: boolean;
  status: StatusFilter | null;
  page: number;
}

export const DEFAULT_FILTERS: FilterState = {
  minScore: null,
  maxRent: null,
  tier: null,
  city: null,
  area: null,
  source: [],
  sort: 'score',
  includeDelisted: false,
  includeDismissed: false,
  status: null,
  page: 1,
};

const SORTS: SortKey[] = ['score', 'rent', 'newest', 'posted', 'area'];
const STATUSES: StatusFilter[] = ['favourite', 'contacted', 'dismissed'];

function num(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function filtersFromQuery(q: URLSearchParams): FilterState {
  const sort = q.get('sort');
  const status = q.get('status');
  return {
    minScore: num(q.get('minScore')),
    maxRent: num(q.get('maxRent')),
    tier: num(q.get('tier')),
    city: q.get('city') || null,
    area: q.get('area') || null,
    source: (q.get('source') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'score',
    includeDelisted: q.get('delisted') === '1',
    includeDismissed: q.get('dismissed') === '1',
    status: STATUSES.includes(status as StatusFilter) ? (status as StatusFilter) : null,
    page: Math.max(1, num(q.get('page')) ?? 1),
  };
}

/** Only what differs from the defaults, so the plain feed is plain `#/`. */
export function queryFromFilters(f: FilterState): URLSearchParams {
  const q = new URLSearchParams();
  if (f.minScore !== null) q.set('minScore', String(f.minScore));
  if (f.maxRent !== null) q.set('maxRent', String(f.maxRent));
  if (f.tier !== null) q.set('tier', String(f.tier));
  if (f.city) q.set('city', f.city);
  if (f.area) q.set('area', f.area);
  if (f.source.length > 0) q.set('source', f.source.join(','));
  if (f.sort !== 'score') q.set('sort', f.sort);
  if (f.includeDelisted) q.set('delisted', '1');
  if (f.includeDismissed) q.set('dismissed', '1');
  if (f.status) q.set('status', f.status);
  if (f.page > 1) q.set('page', String(f.page));
  return q;
}

/** The API's own spelling of the same filters. */
export function feedQueryString(profileId: string, f: FilterState, limit = 30): string {
  const q = new URLSearchParams({ profile: profileId, page: String(f.page), limit: String(limit), sort: f.sort });
  if (f.minScore !== null) q.set('minScore', String(f.minScore));
  if (f.maxRent !== null) q.set('maxRent', String(f.maxRent));
  if (f.tier !== null) q.set('tier', String(f.tier));
  if (f.city) q.set('city', f.city);
  if (f.area) q.set('area', f.area);
  if (f.source.length > 0) q.set('source', f.source.join(','));
  if (f.includeDelisted) q.set('includeDelisted', '1');
  if (f.includeDismissed) q.set('includeDismissed', '1');
  if (f.status) q.set('status', f.status);
  return q.toString();
}

export function activeFilterCount(f: FilterState): number {
  return [
    f.minScore !== null,
    f.maxRent !== null,
    f.tier !== null,
    f.city !== null,
    f.area !== null,
    f.source.length > 0,
    f.sort !== 'score',
    f.includeDelisted,
    f.includeDismissed,
    f.status !== null,
  ].filter(Boolean).length;
}

/** Filters live in the hash; changing one is a navigation, and any change but paging resets the page. */
export function useFilters(query: URLSearchParams, route: Route): [FilterState, (patch: Partial<FilterState>) => void] {
  const filters = filtersFromQuery(query);
  const update = useCallback(
    (patch: Partial<FilterState>) => {
      const next: FilterState = { ...filters, ...patch, page: patch.page ?? 1 };
      navigate(route, queryFromFilters(next));
    },
    // filters is derived from query, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.toString(), route],
  );
  return [filters, update];
}
