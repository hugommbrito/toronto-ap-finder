import { useCallback, type ReactElement, type ReactNode } from 'react';
import type { FeedPage, ProfileSummary, Summary } from '@shared/api-types';
import type { ApiError } from './api/client';
import { useApi } from './api/hooks';
import { Login } from './auth/Login';
import { setToken, useToken } from './auth/token';
import { FilterBar } from './components/FilterBar';
import { Header } from './components/Header';
import { ListingFeed } from './components/ListingFeed';
import { ListingDetail } from './components/detail/ListingDetail';
import { RejectionFunnel } from './components/ops/RejectionFunnel';
import { useMediaQuery } from './lib/useMediaQuery';
import { navigate, toHash, useHashRoute } from './routing/useHashRoute';
import { feedQueryString, useFilters } from './state/useFilters';
import { useProfile } from './state/useProfile';

export function App(): ReactElement {
  const token = useToken();
  if (!token) return <Login />;
  // Keyed on the token, so a fresh sign-in starts from a fresh fetch of the profiles.
  return <Authed key={token} />;
}

function Authed(): ReactElement {
  const profiles = useApi<ProfileSummary[]>('/api/profiles');
  if (profiles.error) return <Notice error={profiles.error} onRetry={profiles.reload} />;
  if (!profiles.data) return <Splash>Carregando…</Splash>;
  if (profiles.data.length === 0) {
    return (
      <Splash>
        Nenhum perfil ativo. Rode <code>pnpm seed</code> no servidor.
      </Splash>
    );
  }
  return <Shell profiles={profiles.data} />;
}

/**
 * One column on a phone, two panes from 1024px: the feed on the left, the open listing on the
 * right. On a phone an open listing replaces the feed and the back link restores it — the filters
 * survive because they live in the hash, not in this component.
 */
function Shell({ profiles }: { profiles: ProfileSummary[] }): ReactElement {
  const [profileId, setProfileId] = useProfile(profiles);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const { route, query } = useHashRoute();
  const [filters, updateFilters] = useFilters(query, route);
  const wide = useMediaQuery('(min-width: 1024px)');

  const summary = useApi<Summary>(profile ? `/api/summary?profile=${encodeURIComponent(profile.id)}` : null);
  const feedPath = profile && route.name !== 'ops' ? `/api/listings?${feedQueryString(profile.id, filters)}` : null;
  const feed = useApi<FeedPage>(feedPath);

  const reloadFeed = feed.reload;
  const reloadSummary = summary.reload;
  const onStateChanged = useCallback(() => {
    // A dismissed listing leaves the default feed and the header counts move; reload both rather
    // than patching, because "what the feed contains" is the server's call.
    reloadFeed();
    reloadSummary();
  }, [reloadFeed, reloadSummary]);

  if (!profile) return <Splash>Nenhum perfil ativo.</Splash>;

  const selectedId = route.name === 'listing' ? route.id : null;
  const showFeed = wide || selectedId === null;
  const showDetail = wide || selectedId !== null;

  return (
    <div className="shell">
      <Header
        profile={profile}
        profiles={profiles}
        summary={summary.data}
        route={route}
        query={query}
        onProfile={setProfileId}
        onLogout={() => setToken(null)}
      />
      {route.name === 'ops' ? (
        <main className="single">
          <RejectionFunnel />
        </main>
      ) : (
        <main className={`panes${selectedId !== null ? ' with-detail' : ''}`}>
          {showFeed && (
            <section className="pane pane-feed" aria-label="Anúncios">
              <FilterBar
                profile={profile}
                filters={filters}
                facets={feed.data?.facets ?? null}
                total={feed.data?.total ?? null}
                onChange={updateFilters}
              />
              <ListingFeed
                page={feed.data}
                loading={feed.loading}
                error={feed.error}
                profile={profile}
                selectedId={selectedId}
                hrefFor={(id) => toHash({ name: 'listing', id }, query)}
                onOpen={(id) => navigate({ name: 'listing', id }, query)}
                onPage={(page) => updateFilters({ page })}
                onStateChanged={onStateChanged}
              />
            </section>
          )}
          {showDetail && (
            <section className="pane pane-detail" aria-label="Detalhe do anúncio">
              {selectedId ? (
                <ListingDetail
                  key={selectedId}
                  id={selectedId}
                  profile={profile}
                  backHref={toHash({ name: 'feed' }, query)}
                  onStateChanged={onStateChanged}
                />
              ) : (
                <div className="placeholder muted">Selecione um anúncio na lista.</div>
              )}
            </section>
          )}
        </main>
      )}
    </div>
  );
}

function Splash({ children }: { children: ReactNode }): ReactElement {
  return <main className="splash">{children}</main>;
}

function Notice({ error, onRetry }: { error: ApiError; onRetry: () => void }): ReactElement {
  return (
    <main className="splash">
      <p className="error">{error.message}</p>
      <div className="row">
        <button type="button" className="btn" onClick={onRetry}>
          Tentar de novo
        </button>
        <button type="button" className="btn" onClick={() => setToken(null)}>
          Trocar token
        </button>
      </div>
    </main>
  );
}
