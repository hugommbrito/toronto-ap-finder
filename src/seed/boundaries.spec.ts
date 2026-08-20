import { describe, expect, it } from 'vitest';
import { buildBoundarySeed, serializeBoundaries, type Vertex } from './boundaries';

/** A square roughly 1 km on a side, with `extra` collinear vertices along the south edge. */
function square(lng: number, lat: number, extra: number): Vertex[] {
  const size = 0.01;
  const south: Vertex[] = Array.from({ length: extra }, (_, i) => [
    lng + (size * (i + 1)) / (extra + 1),
    lat,
  ]);
  return [[lng, lat], ...south, [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]];
}

function feature(name: string, ring: Vertex[], parts: Vertex[][] = []) {
  return {
    properties: { AREA_NAME: name },
    geometry: { type: 'MultiPolygon', coordinates: [[ring], ...parts.map((p) => [p])] },
  };
}

const ALL_SIX = ['SCARBOROUGH', 'NORTH YORK', 'EAST YORK', 'ETOBICOKE', 'YORK', 'TORONTO'];

function collection(overrides: { skip?: string; extra?: number } = {}) {
  const features = ALL_SIX.filter((n) => n !== overrides.skip).map((n, i) =>
    feature(n, square(-79.5 + i * 0.05, 43.7, overrides.extra ?? 0)),
  );
  return { features };
}

describe('buildBoundarySeed', () => {
  it('names the six former municipalities the way a profile spells them', () => {
    const seed = buildBoundarySeed(collection());
    expect(seed.map((b) => b.name).sort()).toEqual([
      'East York',
      'Etobicoke',
      'North York',
      'Old Toronto',
      'Scarborough',
      'York',
    ]);
  });

  it('refuses a partial download instead of writing a seed that silently passes everything', () => {
    // A dataset that lost Scarborough would turn her hard cut into no cut at all.
    expect(() => buildBoundarySeed(collection({ skip: 'SCARBOROUGH' }))).toThrow(/Scarborough/);
  });

  it('drops vertices that sit on the line they are part of', () => {
    const dense = buildBoundarySeed(collection({ extra: 20 }));
    const scarborough = dense.find((b) => b.name === 'Scarborough')!;
    // The 20 collinear points along the south edge carry no information at 25 m tolerance.
    expect(scarborough.ring.length).toBe(5);
  });

  it('keeps the ring closed, since the point-in-polygon test walks it as a loop', () => {
    for (const b of buildBoundarySeed(collection())) {
      expect(b.ring[0]).toEqual(b.ring[b.ring.length - 1]);
    }
  });

  it('takes the mainland when a shape arrives split into parts', () => {
    const island = square(-79.2, 43.6, 0).slice(0, 4);
    const features = collection().features.map((f) =>
      f.properties.AREA_NAME === 'SCARBOROUGH'
        ? feature('SCARBOROUGH', square(-79.5, 43.7, 8), [island])
        : f,
    );
    const scarborough = buildBoundarySeed({ features }).find((b) => b.name === 'Scarborough')!;
    expect(scarborough.ring.length).toBeGreaterThan(island.length);
  });

  it('writes one line per ring, so a moved boundary is a readable diff', () => {
    const text = serializeBoundaries(buildBoundarySeed(collection()));
    expect(JSON.parse(text)).toHaveLength(6);
    expect(text.split('\n').filter((l) => l.includes('"ring"'))).toHaveLength(6);
  });
});
