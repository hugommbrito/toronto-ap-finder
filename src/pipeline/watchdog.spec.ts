import { describe, expect, it } from 'vitest';
import { STALE_AFTER_MS, watchdogAction } from './watchdog.service';
import { windowHours } from '@/operations/operations.controller';

const NOW = new Date('2026-08-18T12:00:00Z');
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000);

describe('watchdogAction', () => {
  it('stays quiet while cycles are finishing', () => {
    expect(watchdogAction({ lastFinishedAt: minutesAgo(20), now: NOW, alerted: false })).toBe('quiet');
  });

  it('alerts once the silence passes ninety minutes', () => {
    expect(watchdogAction({ lastFinishedAt: minutesAgo(91), now: NOW, alerted: false })).toBe('alert');
  });

  it('does not alert again while the outage continues', () => {
    // The failure mode of a watchdog is becoming the noise you learn to ignore.
    expect(watchdogAction({ lastFinishedAt: minutesAgo(300), now: NOW, alerted: true })).toBe('quiet');
  });

  it('says so when cycles come back, and only if it had complained', () => {
    expect(watchdogAction({ lastFinishedAt: minutesAgo(5), now: NOW, alerted: true })).toBe('recovered');
    expect(watchdogAction({ lastFinishedAt: minutesAgo(5), now: NOW, alerted: false })).toBe('quiet');
  });

  it('is silent when no cycle has ever finished', () => {
    // A fresh install is not an outage. Alerting here would train you to ignore the alert on the
    // day it finally means something.
    expect(watchdogAction({ lastFinishedAt: null, now: NOW, alerted: false })).toBe('quiet');
  });

  it('treats the threshold as strictly greater, not equal', () => {
    const exactly = new Date(NOW.getTime() - STALE_AFTER_MS);
    expect(watchdogAction({ lastFinishedAt: exactly, now: NOW, alerted: false })).toBe('quiet');
    expect(watchdogAction({ lastFinishedAt: new Date(exactly.getTime() - 1), now: NOW, alerted: false })).toBe('alert');
  });
});

describe('windowHours', () => {
  it('defaults to a day when absent or nonsense', () => {
    expect(windowHours(undefined)).toBe(24);
    expect(windowHours('banana')).toBe(24);
    expect(windowHours('0')).toBe(24);
    expect(windowHours('-5')).toBe(24);
  });

  it('honours a sensible window and clamps an absurd one', () => {
    expect(windowHours('1')).toBe(1);
    expect(windowHours('168')).toBe(168);
    // A query string must not be able to ask for the entire history in one response.
    expect(windowHours('100000')).toBe(24 * 30);
  });
});
