import { describe, expect, it } from 'vitest';
import type { MapListing, MapSurroundings } from '@shared/api-types';
import {
  boundsOf,
  circleOptions,
  groupByLocation,
  groupCardHtml,
  groupIconClass,
  groupSummaryHtml,
  locationKey,
  markerLook,
  miniCardHtml,
  shouldRefit,
  surroundingsLines,
} from './mapPoints';
import type { Palette } from './mapStyle';

const PALETTE: Palette = { good: '#0g', near: '#0n', low: '#0l' };
const RADII = { daycareRadiusM: 800, transitRadiusM: 900 };
const QUIET: MapSurroundings = { reachableLines: [], nearestDaycare: null, daycareCoverage: 'full' };

function point(over: Partial<MapListing> & { id: string }): MapListing {
  return {
    lat: 43.7,
    lng: -79.4,
    score: 75,
    totalMonthlyCost: 2950,
    beds: 2,
    dens: 1,
    baths: 2,
    areaSqft: 1050,
    tier: '2BR + den',
    title: 'Bright 2BR + den',
    address: '123 Danforth Ave',
    city: 'Toronto',
    source: 'kijiji',
    status: 'none',
    delisted: false,
    surroundings: QUIET,
    ...over,
  };
}

describe('groupByLocation', () => {
  it('stacks listings at one coordinate and keeps the best on top', () => {
    const groups = groupByLocation([
      point({ id: 'low', score: 60 }),
      point({ id: 'high', score: 90 }),
      point({ id: 'elsewhere', score: 70, lat: 43.71 }),
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['high', 'low'], ['elsewhere']]);
    expect(groups[0]!.best.id).toBe('high');
  });

  it('treats a sixth-decimal wobble as one building and a fifth-decimal one as two', () => {
    expect(locationKey(43.7000001, -79.4)).toBe(locationKey(43.7, -79.4));
    expect(locationKey(43.70001, -79.4)).not.toBe(locationKey(43.7, -79.4));
    expect(groupByLocation([point({ id: 'a' }), point({ id: 'b', lat: 43.7000004 })]).length).toBe(1);
  });
});

describe('markerLook', () => {
  const group = (...items: MapListing[]) => groupByLocation(items)[0]!;

  it('colours by the best score and puts the decision on the rim', () => {
    const look = markerLook(group(point({ id: 'a', score: 65, status: 'contacted' }), point({ id: 'b', score: 80, status: 'favourite' })), 70, null);
    expect(look).toEqual({ band: 'good', outline: 'favourite', faded: false, dashed: false, open: false, count: 2 });
  });

  it('fades only when every unit is dismissed, dashes only when every unit is gone', () => {
    expect(markerLook(group(point({ id: 'a', status: 'dismissed' }), point({ id: 'b' })), 70, null).faded).toBe(false);
    expect(markerLook(group(point({ id: 'a', status: 'dismissed' })), 70, null).faded).toBe(true);
    expect(markerLook(group(point({ id: 'a', delisted: true }), point({ id: 'b' })), 70, null).dashed).toBe(false);
    expect(markerLook(group(point({ id: 'a', delisted: true })), 70, null).dashed).toBe(true);
  });

  it('is open when the open listing is anywhere in the group', () => {
    const g = group(point({ id: 'a' }), point({ id: 'b' }));
    expect(markerLook(g, 70, 'b').open).toBe(true);
    expect(markerLook(g, 70, 'z').open).toBe(false);
  });
});

describe('circleOptions and groupIconClass', () => {
  const base = { band: 'near' as const, outline: 'none' as const, faded: false, dashed: false, open: false, count: 1 };

  it('grows the open marker and dashes only the gone one', () => {
    expect(circleOptions(base, PALETTE)).toEqual({ radius: 8, color: '#ffffff', weight: 1.5, opacity: 1, fillColor: '#0n', fillOpacity: 0.9 });
    expect(circleOptions({ ...base, open: true }, PALETTE).radius).toBe(12);
    expect(circleOptions({ ...base, dashed: true }, PALETTE).dashArray).toBe('3 3');
    expect(circleOptions({ ...base, faded: true }, PALETTE).fillOpacity).toBe(0.35);
    expect(circleOptions({ ...base, outline: 'favourite' }, PALETTE)).toMatchObject({ color: '#ca8a04', weight: 3 });
  });

  it('spells the same look as classes for the HTML marker', () => {
    expect(groupIconClass(base)).toBe('unit-marker band-near');
    expect(groupIconClass({ ...base, outline: 'contacted', faded: true, dashed: true, open: true })).toBe(
      'unit-marker band-near outline-contacted faded dashed open',
    );
  });
});

describe('surroundingsLines', () => {
  it('names the nearest daycare and the first line, and counts the rest', () => {
    const lines = surroundingsLines(
      {
        daycareCoverage: 'full',
        nearestDaycare: { name: 'Creche X', distanceM: 320, cwelcc: true, lat: 0, lng: 0 },
        reachableLines: [
          { line: 'Line 2 Bloor-Danforth', station: 'Chester', distanceM: 450, lat: 0, lng: 0 },
          { line: 'Line 1 Yonge-University', station: 'Bloor-Yonge', distanceM: 800, lat: 0, lng: 0 },
        ],
      },
      RADII,
    );
    expect(lines).toEqual([
      '👶 mais próxima: Creche X — 320 m (~4 min a pé) · CWELCC',
      '🚇 Line 2 Bloor-Danforth — Chester, 450 m (~6 min a pé) · +1 linha',
    ]);
  });

  it('says "sem creche" only where a search happened, and "sem metrô" when no line is reachable', () => {
    expect(surroundingsLines(QUIET, RADII)).toEqual(['👶 sem creche num raio de 800 m', '🚇 sem metrô ou LRT num raio de 900 m']);
    // 'none' coverage: nothing was searched, so no claim about daycares at all.
    expect(surroundingsLines({ ...QUIET, daycareCoverage: 'none' }, RADII)).toEqual(['🚇 sem metrô ou LRT num raio de 900 m']);
  });
});

describe('miniCardHtml', () => {
  it('escapes what came from the advertisement', () => {
    const html = miniCardHtml(point({ id: 'a', title: '<b>x</b>', address: 'Rua "A" & B' }), 70, RADII, { openHref: null });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('Rua &quot;A&quot; &amp; B');
  });

  it('shows the score band, the price, the layout and the decision', () => {
    const html = miniCardHtml(point({ id: 'a', score: 82, status: 'favourite', delisted: true }), 70, RADII, { openHref: null });
    expect(html).toContain('score-good');
    expect(html).toContain('>82<');
    expect(html).toContain('CAD 2.950');
    expect(html).toContain('2 quartos + den · 1.050 sq ft (~98 m²) · 2 banheiros');
    expect(html).toContain('★ Favorito · removido da fonte');
    expect(html).not.toContain('abrir ›');
  });

  it('offers "abrir ›" only when told where it goes, with the href escaped', () => {
    const html = miniCardHtml(point({ id: 'a' }), 70, RADII, { openHref: '#/l/a?view=map&x="1"' });
    expect(html).toContain('href="#/l/a?view=map&amp;x=&quot;1&quot;"');
    expect(html).toContain('abrir ›');
  });
});

describe('group cards', () => {
  const g = groupByLocation([point({ id: 'a', score: 84, totalMonthlyCost: 3050 }), point({ id: 'b', score: 71, totalMonthlyCost: 2850, status: 'contacted' })])[0]!;

  it('summarises a building for a hover', () => {
    const html = groupSummaryHtml(g);
    expect(html).toContain('2 unidades');
    expect(html).toContain('melhor score 84');
    expect(html).toContain('a partir de CAD 2.850');
  });

  it('lists every unit as a link, best first', () => {
    const html = groupCardHtml(g, 70, (id) => `#/l/${id}`);
    expect(html.indexOf('#/l/a')).toBeLessThan(html.indexOf('#/l/b'));
    expect(html).toContain('✓ Contatei');
    expect(html.match(/<li>/g)?.length).toBe(2);
  });
});

describe('shouldRefit and boundsOf', () => {
  const pts = [
    { lat: 43.7, lng: -79.4 },
    { lat: 43.8, lng: -79.3 },
  ];

  it('fits the first time, stays put while a result is in view, refits when none is', () => {
    expect(shouldRefit(null, pts)).toBe(true);
    expect(shouldRefit({ north: 43.75, south: 43.65, east: -79.35, west: -79.45 }, pts)).toBe(false);
    expect(shouldRefit({ north: 44.5, south: 44.4, east: -79.0, west: -79.1 }, pts)).toBe(true);
  });

  it('never moves the map for an empty result', () => {
    expect(shouldRefit(null, [])).toBe(false);
    expect(boundsOf([])).toBeNull();
  });

  it('spans all the points', () => {
    expect(boundsOf(pts)).toEqual({ north: 43.8, south: 43.7, east: -79.3, west: -79.4 });
  });
});
