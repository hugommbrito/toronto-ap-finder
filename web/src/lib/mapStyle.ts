/**
 * What both maps share: the escaper for popup HTML, the colours of the fixed geography, and the
 * way the score bands become literal colours.
 */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const COLOURS = {
  home: '#0f766e',
  operational: '#1d4ed8',
  future: '#6b7280',
  cwelcc: '#6d28d9',
  daycare: '#d97706',
  excluded: '#6b7280',
};

/** Below this zoom the ~2,000 daycares are noise; at it, they are a neighbourhood's worth. */
export const DAYCARE_MIN_ZOOM = 15;

export interface Palette {
  good: string;
  near: string;
  low: string;
}

/** tokens.css, light theme — the fallback when the document is not there to be asked. */
const LIGHT: Palette = { good: '#15803d', near: '#b45309', low: '#64707c' };

/**
 * The score-band colours as the page is currently showing them.
 *
 * Leaflet's canvas renderer needs literal colours, so the CSS variables are read rather than
 * referenced — which is also what makes a marker drawn in dark mode use the dark-mode token.
 */
export function readPalette(): Palette {
  if (typeof document === 'undefined') return LIGHT;
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return { good: read('--good', LIGHT.good), near: read('--near', LIGHT.near), low: read('--low', LIGHT.low) };
}
