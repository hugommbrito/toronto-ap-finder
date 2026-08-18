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

  constructor(private readonly options: RateLimiterOptions) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
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

    const waitMs = this.lastRequestAt + this.options.minIntervalMs - Date.now();
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
