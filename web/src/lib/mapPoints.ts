import type { MapListing, MapSurroundings } from '@shared/api-types';
import {
  STATUS_LABEL,
  areaLabel,
  cad,
  layoutLabel,
  money,
  nearestDaycareLabel,
  plural,
  scoreBand,
  transitLineLabel,
  transitNoneLabel,
  type ScoreBand,
} from './labels';
import { esc, type Palette } from './mapStyle';

/**
 * Everything about the map view that can be decided without Leaflet or a DOM: how listings stack
 * into markers, what a marker looks like, what its card says, and when the map should move.
 */

/** Six decimals is ~10 cm: two sources describing one building agree to that, two buildings never do. */
export const LOCATION_DECIMALS = 6;

export function locationKey(lat: number, lng: number): string {
  return `${lat.toFixed(LOCATION_DECIMALS)},${lng.toFixed(LOCATION_DECIMALS)}`;
}

export interface PointGroup {
  key: string;
  lat: number;
  lng: number;
  /** Score-descending, so the first is the best. */
  items: MapListing[];
  best: MapListing;
}

/**
 * One marker per location. Zumper and CAPREIT give a building's coordinate to every unit in it,
 * so several listings at one point are the normal case, not a collision to resolve.
 */
export function groupByLocation(items: readonly MapListing[]): PointGroup[] {
  const groups = new Map<string, PointGroup>();
  for (const it of items) {
    const key = locationKey(it.lat, it.lng);
    const g = groups.get(key);
    if (g) g.items.push(it);
    else groups.set(key, { key, lat: it.lat, lng: it.lng, items: [it], best: it });
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => b.score - a.score);
    g.best = g.items[0]!;
  }
  return [...groups.values()];
}

export type Outline = 'none' | 'favourite' | 'contacted';

export interface MarkerLook {
  /** The colour: the best score in the group against the profile's bar. */
  band: ScoreBand;
  /** The decision, on the rim. A favourite anywhere in the group outranks a contact. */
  outline: Outline;
  /** Every unit dismissed — the group is noise until "mostrar descartados" says otherwise. */
  faded: boolean;
  /** Every unit gone from its source. */
  dashed: boolean;
  /** Holds the listing that is open on the right. */
  open: boolean;
  count: number;
}

export function markerLook(group: PointGroup, minScore: number, openId: string | null): MarkerLook {
  const statuses = group.items.map((i) => i.status);
  return {
    band: scoreBand(group.best.score, minScore),
    outline: statuses.includes('favourite') ? 'favourite' : statuses.includes('contacted') ? 'contacted' : 'none',
    faded: group.items.every((i) => i.status === 'dismissed'),
    dashed: group.items.every((i) => i.delisted),
    open: openId !== null && group.items.some((i) => i.id === openId),
    count: group.items.length,
  };
}

export const OUTLINE_COLOURS: Record<Outline, string> = { none: '#ffffff', favourite: '#ca8a04', contacted: '#16a34a' };
export const MARKER_RADIUS = 8;
export const OPEN_MARKER_RADIUS = 12;

/** The subset of L.CircleMarkerOptions a look decides. Plain data, so it can be asserted on. */
export interface CircleLook {
  radius: number;
  color: string;
  weight: number;
  opacity: number;
  fillColor: string;
  fillOpacity: number;
  dashArray?: string;
}

export function circleOptions(look: MarkerLook, palette: Palette): CircleLook {
  return {
    radius: look.open ? OPEN_MARKER_RADIUS : MARKER_RADIUS,
    color: OUTLINE_COLOURS[look.outline],
    weight: look.outline === 'none' ? 1.5 : 3,
    opacity: look.faded ? 0.5 : 1,
    fillColor: palette[look.band],
    fillOpacity: look.faded ? 0.35 : 0.9,
    ...(look.dashed ? { dashArray: '3 3' } : {}),
  };
}

/** For the numbered building marker, which is HTML and so is styled by class rather than by option. */
export function groupIconClass(look: MarkerLook): string {
  const classes = ['unit-marker', `band-${look.band}`];
  if (look.outline !== 'none') classes.push(`outline-${look.outline}`);
  if (look.faded) classes.push('faded');
  if (look.dashed) classes.push('dashed');
  if (look.open) classes.push('open');
  return classes.join(' ');
}

export interface SurroundingsRadii {
  daycareRadiusM: number | null;
  transitRadiusM: number;
}

/**
 * The surroundings in two lines, worded as the detail words them. Under `none` coverage nothing
 * was searched, so the daycare line is left out rather than allowed to say "sem creche".
 */
export function surroundingsLines(s: MapSurroundings, radii: SurroundingsRadii): string[] {
  const lines: string[] = [];
  if (s.daycareCoverage !== 'none') {
    if (s.nearestDaycare) lines.push(`👶 ${nearestDaycareLabel(s.nearestDaycare)}`);
    else if (radii.daycareRadiusM !== null) lines.push(`👶 sem creche num raio de ${money(radii.daycareRadiusM)} m`);
  }
  const [first, ...rest] = s.reachableLines;
  if (!first) lines.push(`🚇 ${transitNoneLabel(radii.transitRadiusM)}`);
  else {
    const more = rest.length > 0 ? ` · +${rest.length} ${plural(rest.length, 'linha', 'linhas')}` : '';
    lines.push(`🚇 ${transitLineLabel(first)}${more}`);
  }
  return lines;
}

const STATE_ICON: Record<MapListing['status'], string> = { none: '', favourite: '★', contacted: '✓', dismissed: '✕' };

function stateMark(p: MapListing): string | null {
  if (p.status === 'none') return null;
  return `${STATE_ICON[p.status]} ${STATUS_LABEL[p.status]}`;
}

function featureLine(p: MapListing): string {
  const parts = [layoutLabel(p.beds, p.dens)];
  if (p.areaSqft !== null) parts.push(areaLabel(p.areaSqft));
  if (p.baths !== null) parts.push(`${p.baths} ${plural(p.baths, 'banheiro', 'banheiros')}`);
  return parts.join(' · ');
}

function whereLine(p: MapListing): string {
  return [p.address ?? 'endereço não informado', p.city].filter((x): x is string => Boolean(x)).join(' · ');
}

export interface MiniCardOptions {
  /** Where "abrir ›" goes. Null on a hover device, where the click on the marker itself opens. */
  openHref: string | null;
}

/**
 * The card a marker shows. Every value from the listing passes through `esc`, the href included:
 * this is HTML handed to Leaflet, and the page's CSP forbids inline script, so a link is the only
 * behaviour it may carry.
 */
export function miniCardHtml(p: MapListing, minScore: number, radii: SurroundingsRadii, opts: MiniCardOptions): string {
  const band = scoreBand(p.score, minScore);
  const flags = [stateMark(p), p.delisted ? 'removido da fonte' : null].filter((x): x is string => x !== null);
  const parts = [
    `<div class="minicard-head"><span class="score score-${band}">${Math.round(p.score)}</span>`,
    `<div><strong>${esc(cad(p.totalMonthlyCost))}</strong>/mês<br><span class="muted">${esc(featureLine(p))}</span></div></div>`,
    `<div class="minicard-title">${esc(p.title)}</div>`,
    `<div>📍 ${esc(whereLine(p))}</div>`,
    ...surroundingsLines(p.surroundings, radii).map((line) => `<div>${esc(line)}</div>`),
  ];
  if (flags.length > 0) parts.push(`<div class="minicard-state">${esc(flags.join(' · '))}</div>`);
  if (opts.openHref !== null) parts.push(`<a class="btn minicard-open" href="${esc(opts.openHref)}">abrir ›</a>`);
  return `<div class="minicard">${parts.join('')}</div>`;
}

/** What a hover over a numbered marker says: enough to decide whether to open it. */
export function groupSummaryHtml(g: PointGroup): string {
  const n = g.items.length;
  const cheapest = Math.min(...g.items.map((i) => i.totalMonthlyCost));
  return (
    `<div class="minicard"><strong>${n} ${plural(n, 'unidade', 'unidades')}</strong> · melhor score ${Math.round(g.best.score)}` +
    ` · a partir de ${esc(cad(cheapest))}/mês<br>📍 ${esc(whereLine(g.best))}</div>`
  );
}

/** The units in a building, each a link to its detail. Plain anchors: the hash does the navigating. */
export function groupCardHtml(g: PointGroup, minScore: number, hrefFor: (id: string) => string): string {
  const n = g.items.length;
  const rows = g.items
    .map((i) => {
      const mark = stateMark(i);
      const area = i.areaSqft !== null ? ` · ${esc(money(i.areaSqft))} sq ft` : '';
      return (
        `<li><a href="${esc(hrefFor(i.id))}"><span class="score score-${scoreBand(i.score, minScore)}">${Math.round(i.score)}</span>` +
        ` <strong>${esc(cad(i.totalMonthlyCost))}</strong> · ${esc(layoutLabel(i.beds, i.dens))}${area}` +
        `${mark ? ` · ${esc(mark)}` : ''}${i.delisted ? ' · removido' : ''} ›</a></li>`
      );
    })
    .join('');
  return (
    `<div class="minicard group"><strong>${esc(whereLine(g.best))}</strong> · ${n} ${plural(n, 'unidade', 'unidades')}` +
    `<ol class="plain">${rows}</ol></div>`
  );
}

export interface PlainBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function boundsOf(points: ReadonlyArray<{ lat: number; lng: number }>): PlainBounds | null {
  const first = points[0];
  if (!first) return null;
  const b = { north: first.lat, south: first.lat, east: first.lng, west: first.lng };
  for (const p of points) {
    if (p.lat > b.north) b.north = p.lat;
    if (p.lat < b.south) b.south = p.lat;
    if (p.lng > b.east) b.east = p.lng;
    if (p.lng < b.west) b.west = p.lng;
  }
  return b;
}

function inside(b: PlainBounds, p: { lat: number; lng: number }): boolean {
  return p.lat <= b.north && p.lat >= b.south && p.lng <= b.east && p.lng >= b.west;
}

/**
 * Whether new results should move the map. A first load (no viewport yet) fits; a filter change
 * that leaves at least one result in view keeps the user's position; one that empties the view
 * refits, because a map showing nothing is not showing the filter.
 */
export function shouldRefit(viewport: PlainBounds | null, points: ReadonlyArray<{ lat: number; lng: number }>): boolean {
  if (points.length === 0) return false;
  if (viewport === null) return true;
  return !points.some((p) => inside(viewport, p));
}
