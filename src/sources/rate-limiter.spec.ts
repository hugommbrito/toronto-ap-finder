import { describe, expect, it } from 'vitest';
import { RateLimiter, SourcePausedError } from './rate-limiter';
import { HttpStatusError } from '@/seed/http';

const fast = (overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}): RateLimiter =>
  new RateLimiter({ name: 'test', minIntervalMs: 1, baseBackoffMs: 1, ...overrides });

describe('RateLimiter', () => {
  it('passes results through and stays closed while things work', async () => {
    const limiter = fast();
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
    expect(limiter.paused).toBe(false);
  });

  it('keeps a minimum interval between requests', async () => {
    const limiter = new RateLimiter({ name: 'test', minIntervalMs: 60, baseBackoffMs: 1 });
    const started = Date.now();
    await limiter.run(async () => 1);
    await limiter.run(async () => 2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('opens the circuit after three ordinary failures', async () => {
    const limiter = fast();
    const boom = async (): Promise<never> => {
      throw new Error('network down');
    };
    await expect(limiter.run(boom)).rejects.toThrow('network down');
    await expect(limiter.run(boom)).rejects.toThrow('network down');
    await expect(limiter.run(boom)).rejects.toThrow(SourcePausedError);
    expect(limiter.paused).toBe(true);
  });

  /**
   * The behaviour that matters most in practice. A live cycle earned a 429 from Kijiji;
   * spending two more requests to confirm what the source already said is how throttling
   * becomes a ban.
   */
  it('stops immediately on a 429 rather than spending two more requests', async () => {
    const limiter = fast();
    const throttled = async (): Promise<never> => {
      throw new HttpStatusError(429, 'https://example.com');
    };
    await expect(limiter.run(throttled)).rejects.toThrow(SourcePausedError);
    expect(limiter.paused).toBe(true);
    expect(limiter.failures).toBe(3);
  });

  it('stops immediately on a 403 too', async () => {
    const limiter = fast();
    const forbidden = async (): Promise<never> => {
      throw new HttpStatusError(403, 'https://example.com');
    };
    await expect(limiter.run(forbidden)).rejects.toThrow(SourcePausedError);
  });

  it('explains why it paused', async () => {
    const limiter = fast();
    try {
      await limiter.run(async () => {
        throw new HttpStatusError(429, 'https://example.com');
      });
    } catch (err) {
      expect((err as Error).message).toContain('429');
      expect((err as Error).message).toContain('back off');
    }
  });

  it('refuses further work while paused, without making a request', async () => {
    const limiter = fast();
    await limiter.run(async () => {
      throw new HttpStatusError(429, 'https://example.com');
    }).catch(() => undefined);

    let called = false;
    await expect(
      limiter.run(async () => {
        called = true;
        return 'should not happen';
      }),
    ).rejects.toThrow(SourcePausedError);
    expect(called).toBe(false);
  });

  it('recovers after a successful call and after an explicit reset', async () => {
    const limiter = fast();
    await limiter.run(async () => {
      throw new Error('blip');
    }).catch(() => undefined);
    expect(limiter.failures).toBe(1);
    await limiter.run(async () => 'ok');
    expect(limiter.failures).toBe(0);

    await limiter.run(async () => {
      throw new HttpStatusError(429, 'https://example.com');
    }).catch(() => undefined);
    expect(limiter.paused).toBe(true);
    limiter.reset();
    expect(limiter.paused).toBe(false);
  });
});

describe('HttpStatusError', () => {
  it('recognises the statuses that mean "back off"', () => {
    expect(new HttpStatusError(429, 'u').isRateLimit).toBe(true);
    expect(new HttpStatusError(403, 'u').isRateLimit).toBe(true);
    expect(new HttpStatusError(404, 'u').isRateLimit).toBe(false);
    expect(new HttpStatusError(500, 'u').isRateLimit).toBe(false);
  });
});
