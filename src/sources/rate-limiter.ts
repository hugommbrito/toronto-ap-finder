import { HttpStatusError, sleep } from '@/seed/http';

export class SourcePausedError extends Error {
  constructor(source: string, reason: string, cause?: unknown) {
    super(`Source "${source}" paused: ${reason}`);
    this.name = 'SourcePausedError';
    this.cause = cause;
  }
}

export interface RateLimiterOptions {
  name: string;
  /** Floor between requests. The brief sets a 2 s minimum for every source. */
  minIntervalMs: number;
  /**
   * Random extra delay, 0 to this, added on top of the floor for every request.
   *
   * **Additive, never a replacement.** Section 7 of the addendum asks for a 2–5 s randomised gap,
   * and that reads as a reduction here: Kijiji's 12 s is a measurement, not a preference — 2 s
   * earned a 429 after two dozen requests and 6 s was refused on the next cycle's first request.
   * The point of jitter is that an interval of exactly 1200 s is a machine signature, and that is
   * fixed by making the gap unpredictable rather than shorter.
   */
  jitterMs?: number;
  /** Injectable so the pacing can be tested without waiting for a random number. */
  random?: () => number;
  /** Consecutive failures before the source stops being polled. */
  maxConsecutiveFailures?: number;
  baseBackoffMs?: number;
}

/**
 * Paces requests to one source and gives up deliberately rather than hammering.
 *
 * Three behaviours, all required by section 13 of the brief: a hard floor between
 * requests, exponential backoff on 429/403, and a circuit that opens after repeated
 * failures so a blocked source stops being poked and raises an alert instead.
 */
export class RateLimiter {
  private lastRequestAt = 0;
  private pausedAt = 0;
  private consecutiveFailures = 0;
  private pauseReason: string | null = null;
  private requestCount = 0;
  private readonly maxConsecutiveFailures: number;
  private readonly baseBackoffMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;

  constructor(private readonly options: RateLimiterOptions) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.jitterMs = options.jitterMs ?? 0;
    this.random = options.random ?? Math.random;
  }

  /** The gap this request will observe: the measured floor, plus an unpredictable tail. */
  private gapMs(): number {
    return this.options.minIntervalMs + Math.floor(this.random() * (this.jitterMs + 1));
  }

  get paused(): boolean {
    return this.consecutiveFailures >= this.maxConsecutiveFailures;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  /** Requests actually attempted since the process started. Surfaced by /health. */
  get requests(): number {
    return this.requestCount;
  }

  get reason(): string | null {
    return this.pauseReason;
  }

  /**
   * Clears the circuit once enough time has passed since it opened.
   *
   * A paused source that never recovers is just a broken monitor. The gap between cycles is
   * itself the backoff — twenty minutes of silence is a far more convincing apology to a
   * rate limiter than any retry schedule.
   */
  resetIfCooledDown(cooldownMs: number): boolean {
    if (!this.paused) return false;
    if (Date.now() - this.pausedAt < cooldownMs) return false;
    this.reset();
    return true;
  }

  /** Clears the circuit — used when a new cycle starts after an operator intervened. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.pauseReason = null;
    this.pausedAt = 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.paused) {
      throw new SourcePausedError(this.options.name, this.pauseReason ?? 'circuit open');
    }

    // `lastRequestAt` is stamped after the callback settles rather than before it, so the real
    // gap is floor + jitter + however long the source took to answer. Already generous; worth
    // knowing before anyone "optimises" where the stamp goes.
    const waitMs = this.lastRequestAt + this.gapMs() - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    this.requestCount += 1;
    try {
      const result = await fn();
      this.lastRequestAt = Date.now();
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.lastRequestAt = Date.now();

      // A 429 or 403 is the source telling us to stop, not a failure to retry past. Waiting
      // for a third strike would mean two more requests it already refused, which is how
      // throttling turns into a ban. Stop the source now and let the next cycle try.
      if (err instanceof HttpStatusError && err.isRateLimit) {
        this.consecutiveFailures = this.maxConsecutiveFailures;
        this.pausedAt = Date.now();
        this.pauseReason = `HTTP ${err.status} — the source asked us to back off`;
        throw new SourcePausedError(this.options.name, this.pauseReason, err);
      }

      this.consecutiveFailures += 1;
      if (this.paused) {
        this.pausedAt = Date.now();
        this.pauseReason = `${this.consecutiveFailures} consecutive failures`;
        throw new SourcePausedError(this.options.name, this.pauseReason, err);
      }
      // Back off before the caller's next attempt, so a retry loop cannot run hot.
      await sleep(this.baseBackoffMs * 2 ** (this.consecutiveFailures - 1));
      throw err;
    }
  }
}
