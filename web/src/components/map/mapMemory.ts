/**
 * What the map remembers between mounts, and why not in the hash.
 *
 * Focus — "centre on this listing when you open" — is a one-time instruction. In the hash it would
 * fire again on every later filter change, and on the way back from a detail it would re-centre on
 * the listing instead of restoring the place the reader had panned to. So it is handed over in
 * memory and read once.
 *
 * The viewport lives in sessionStorage: per tab, gone when the tab is. localStorage would bring a
 * week-old position back on a fresh visit and fight "ajustar aos resultados".
 */

let pendingFocus: string | null = null;

export function requestFocus(id: string): void {
  pendingFocus = id;
}

/** Read once: a second call answers null. */
export function takeFocus(): string | null {
  const id = pendingFocus;
  pendingFocus = null;
  return id;
}

export interface Viewport {
  lat: number;
  lng: number;
  zoom: number;
}

const key = (profileId: string): string => `rental-ui-map:${profileId}`;

export function saveViewport(profileId: string, v: Viewport): void {
  try {
    sessionStorage.setItem(key(profileId), JSON.stringify(v));
  } catch {
    // Remembering the position is a convenience; failing to is not an error.
  }
}

export function loadViewport(profileId: string): Viewport | null {
  try {
    const raw = sessionStorage.getItem(key(profileId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Viewport>;
    if ([v.lat, v.lng, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return v as Viewport;
    return null;
  } catch {
    return null;
  }
}
