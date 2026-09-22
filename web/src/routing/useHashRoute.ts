import { useEffect, useState } from 'react';

/**
 * Hash routing: `#/`, `#/l/<id>`, `#/ops`, each optionally followed by `?filters`.
 *
 * Hash rather than paths because the bundle is served by `express.static` next to the API, and a
 * path like /l/abc would have to be rewritten to index.html by a fallback route that also has to
 * know not to swallow /api and /health. The hash never reaches the server. The filters ride in
 * the hash's query so a filtered feed is a link you can send.
 */
export type Route = { name: 'feed' } | { name: 'listing'; id: string } | { name: 'ops' };

export interface HashState {
  route: Route;
  query: URLSearchParams;
}

export function parseHash(hash: string): HashState {
  const raw = hash.replace(/^#/, '');
  const at = raw.indexOf('?');
  const path = at === -1 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at === -1 ? '' : raw.slice(at + 1));
  const listing = /^\/l\/([^/?]+)$/.exec(path);
  const route: Route = listing ? { name: 'listing', id: listing[1]! } : path === '/ops' ? { name: 'ops' } : { name: 'feed' };
  return { route, query };
}

export function toHash(route: Route, query: URLSearchParams): string {
  const path = route.name === 'listing' ? `/l/${route.id}` : route.name === 'ops' ? '/ops' : '/';
  const qs = query.toString();
  return `#${path}${qs ? `?${qs}` : ''}`;
}

export function navigate(route: Route, query: URLSearchParams): void {
  window.location.hash = toHash(route, query);
}

function read(): HashState {
  return parseHash(window.location.hash);
}

export function useHashRoute(): HashState {
  const [state, setState] = useState<HashState>(read);
  useEffect(() => {
    const onChange = (): void => setState(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return state;
}
