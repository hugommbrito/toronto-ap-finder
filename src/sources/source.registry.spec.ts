import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceRegistry, newlyPaused } from './source.registry';
import type { SourceHealth } from './source.interface';

function fakeSource(name: string, paused: boolean): SourceHealth {
  return {
    name: name as SourceHealth['name'],
    paused,
    stats: { requests: 0, paused, reason: paused ? 'HTTP 429' : null },
    resetIfCooledDown: () => false,
  };
}

describe('SourceRegistry', () => {
  const original = process.env.DISABLED_SOURCES;

  beforeEach(() => {
    delete process.env.DISABLED_SOURCES;
    // The registry reads typed config through loadEnv(), which validates the whole environment —
    // so constructing one needs a DATABASE_URL even though it never opens a connection. Supplied
    // here rather than loosened in the registry: config validation staying strict is worth more
    // than a tidier test.
    process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DISABLED_SOURCES;
    else process.env.DISABLED_SOURCES = original;
  });

  it('hands back the same instances every time', () => {
    // The load-bearing property, and the reason the sources were instance fields before: the
    // rate limiter's open circuit lives inside the source, so a fresh instance would forget that
    // Kijiji refused us twenty minutes ago and walk straight back into the block.
    const registry = new SourceRegistry();
    expect(registry.unitSources()[0]).toBe(registry.unitSources()[0]);
    expect(registry.buildingSources()[0]).toBe(registry.buildingSources()[0]);
  });

  it('registers Kijiji as a unit source and Zumper as a building source', () => {
    const registry = new SourceRegistry();
    expect(registry.unitSources().map((s) => s.name)).toEqual(['kijiji']);
    expect(registry.buildingSources().map((s) => s.name)).toEqual(['zumper', 'capreit']);
    // The two stages mean different things for the two shapes, which is why they stay separate.
    expect(registry.buildingSources()[0]!.granularity).toBe('building');
  });

  it('reports every source, not only the first', () => {
    // The bug this replaces: /health and the pause alert both read one hardcoded source, so a
    // paused Zumper was invisible in both.
    const registry = new SourceRegistry();
    expect(registry.all().map((s) => s.name).sort()).toEqual(['capreit', 'kijiji', 'zumper']);
    expect(Object.keys(registry.health()).sort()).toEqual(['capreit', 'kijiji', 'zumper']);
    expect(registry.pausedSources()).toEqual([]);
  });

  it('excludes what DISABLED_SOURCES names, and tolerates spacing', () => {
    process.env.DISABLED_SOURCES = ' zumper , capreit ';
    const registry = new SourceRegistry();
    expect(registry.buildingSources()).toEqual([]);
    expect(registry.unitSources().map((s) => s.name)).toEqual(['kijiji']);
  });
});

describe('newlyPaused', () => {
  it('returns only paused sources nobody has been told about', () => {
    const sources = [fakeSource('kijiji', true), fakeSource('zumper', false)];
    expect(newlyPaused(sources, new Set()).map((s) => s.name)).toEqual(['kijiji']);
    expect(newlyPaused(sources, new Set(['kijiji']))).toEqual([]);
  });

  it('announces a second source pausing during the same outage', () => {
    // One alert per source, not one per incident: if Zumper goes down while Kijiji is already
    // known to be down, that is news.
    const sources = [fakeSource('kijiji', true), fakeSource('zumper', true)];
    expect(newlyPaused(sources, new Set(['kijiji'])).map((s) => s.name)).toEqual(['zumper']);
  });

  it('says nothing when everything is healthy', () => {
    expect(newlyPaused([fakeSource('kijiji', false)], new Set())).toEqual([]);
  });
});
