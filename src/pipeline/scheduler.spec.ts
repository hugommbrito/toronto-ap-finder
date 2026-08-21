import { describe, expect, it } from 'vitest';
import { CYCLE_MAX_MS, CYCLE_MIN_MS, nextIntervalMs } from './scheduler.service';
import { RateLimiter } from '@/sources/rate-limiter';

describe('nextIntervalMs', () => {
  it('stays inside the 15–35 minute window, over many draws', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const ms = nextIntervalMs(0);
      expect(ms).toBeGreaterThanOrEqual(CYCLE_MIN_MS);
      expect(ms).toBeLessThanOrEqual(CYCLE_MAX_MS);
    }
  });

  it('never repeats the previous interval — the acceptance criterion, tested', () => {
    let previous = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const ms = nextIntervalMs(previous);
      expect(ms).not.toBe(previous);
      previous = ms;
    }
  });

  it('still moves when the random source is stuck', () => {
    // A constant generator is the degenerate case the nudge exists for.
    const stuck = (): number => 0.5;
    const first = nextIntervalMs(0, stuck);
    expect(nextIntervalMs(first, stuck)).not.toBe(first);
  });

  it('nudges inward at both ends rather than leaving the window', () => {
    const atFloor = nextIntervalMs(CYCLE_MIN_MS, () => 0);
    expect(atFloor).toBeGreaterThanOrEqual(CYCLE_MIN_MS);
    const atCeiling = nextIntervalMs(CYCLE_MAX_MS, () => 0.999999);
    expect(atCeiling).toBeLessThanOrEqual(CYCLE_MAX_MS);
    expect(atCeiling).not.toBe(CYCLE_MAX_MS);
  });

  it('lands on whole seconds, so "the same interval" is a meaningful thing to avoid', () => {
    for (let i = 0; i < 100; i += 1) expect(nextIntervalMs(0) % 1000).toBe(0);
  });
});

describe('per-request jitter', () => {
  const gaps = async (jitterMs: number, random: () => number): Promise<number[]> => {
    const limiter = new RateLimiter({ name: 'test', minIntervalMs: 60, jitterMs, random });
    const at: number[] = [];
    for (let i = 0; i < 3; i += 1) await limiter.run(async () => at.push(Date.now()));
    return at.slice(1).map((t, i) => t - at[i]!);
  };

  it('never goes below the measured floor', async () => {
    // The floor is a measurement — 2 s and 6 s both earned a 429 from Kijiji. Jitter is added on
    // top of it and must never be able to reduce it.
    for (const gap of await gaps(40, () => 0)) expect(gap).toBeGreaterThanOrEqual(55);
  });

  it('adds the tail when the draw is high', async () => {
    for (const gap of await gaps(40, () => 0.999)) expect(gap).toBeGreaterThanOrEqual(90);
  });

  it('produces gaps that differ, which is the entire point', async () => {
    let n = 0;
    const observed = await gaps(60, () => [0.05, 0.95, 0.5][n++ % 3]!);
    expect(new Set(observed).size).toBeGreaterThan(1);
  });

  it('behaves exactly as before when no jitter is configured', async () => {
    const limiter = new RateLimiter({ name: 'test', minIntervalMs: 50 });
    const at: number[] = [];
    for (let i = 0; i < 2; i += 1) await limiter.run(async () => at.push(Date.now()));
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(45);
  });
});
