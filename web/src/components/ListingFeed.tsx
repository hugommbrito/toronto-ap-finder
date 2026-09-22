import type { ReactElement } from 'react';
import type { FeedPage, ProfileSummary } from '@shared/api-types';
import type { ApiError } from '../api/client';
import { ListingCard } from './ListingCard';

interface Props {
  page: FeedPage | null;
  loading: boolean;
  error: ApiError | null;
  profile: ProfileSummary;
  selectedId: string | null;
  hrefFor: (id: string) => string;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
  onStateChanged: () => void;
  /** The same filters as a map; `onMap` also asks the map to centre on the card's listing. */
  mapHref: string;
  onMap: (id: string) => void;
}

export function ListingFeed({
  page,
  loading,
  error,
  profile,
  selectedId,
  hrefFor,
  onOpen,
  onPage,
  onStateChanged,
  mapHref,
  onMap,
}: Props): ReactElement {
  if (error) return <p className="error pad">{error.message}</p>;
  if (!page) return <p className="muted pad">Carregando anúncios…</p>;

  const { items, total, limit } = page;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page.page - 1) * limit + 1;
  const to = Math.min(total, page.page * limit);

  return (
    <div className={`feed${loading ? ' loading' : ''}`} aria-busy={loading}>
      {items.length === 0 ? (
        <p className="muted pad">
          Nenhum anúncio com esses filtros. Baixe o score mínimo para ver os que quase passaram, ou marque
          “mostrar descartados”.
        </p>
      ) : (
        <ol className="cards plain">
          {items.map((item) => (
            <li key={item.listing.id}>
              <ListingCard
                item={item}
                profile={profile}
                selected={item.listing.id === selectedId}
                href={hrefFor(item.listing.id)}
                onOpen={() => onOpen(item.listing.id)}
                onStateChanged={onStateChanged}
                mapHref={mapHref}
                onMap={() => onMap(item.listing.id)}
              />
            </li>
          ))}
        </ol>
      )}
      {total > limit && (
        <nav className="pager" aria-label="Páginas">
          <button type="button" className="btn" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>
            ‹ anterior
          </button>
          <span className="muted">
            {from}–{to} de {total}
          </span>
          <button type="button" className="btn" disabled={page.page >= pages} onClick={() => onPage(page.page + 1)}>
            próxima ›
          </button>
        </nav>
      )}
    </div>
  );
}
