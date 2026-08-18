import { fetch } from 'undici';
import { userAgent } from '@/config/env';

export interface FetchOptions {
  contactEmail?: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Attempts before giving up. Backoff is exponential. */
  retries?: number;
}

const BASE_BACKOFF_MS = 1_000;

/** Carries the status code so callers can tell "slow down" apart from "broken". */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body?: string,
  ) {
    super(`${url} responded ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpStatusError';
  }

  /** The source is explicitly telling us to back off. */
  get isRateLimit(): boolean {
    return this.status === 429 || this.status === 403;
  }
}

/**
 * undici's spec-compliant fetch, which follows redirects — the CKAN resource URL bounces
 * before serving the CSV, so that matters.
 *
 * 5xx and network errors are retried with exponential backoff. 429 and 403 are **not**:
 * retrying a "slow down" a second later is what turns throttling into a ban. Those are
 * thrown immediately so the caller's rate limiter can stop the source properly.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const retries = options.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }

    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        body: options.body,
        headers: {
          'user-agent': userAgent(options.contactEmail),
          accept: '*/*',
          ...options.headers,
        },
      });

      if (res.status === 429 || res.status === 403) {
        throw new HttpStatusError(res.status, url);
      }
      if (res.status >= 500) {
        lastError = new HttpStatusError(res.status, url);
        continue;
      }
      if (!res.ok) {
        throw new HttpStatusError(res.status, url, await res.text());
      }

      return await res.text();
    } catch (err) {
      if (err instanceof HttpStatusError && err.isRateLimit) throw err;
      lastError = err;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`fetch failed after ${retries} attempts: ${detail}`, { cause: lastError });
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  return JSON.parse(text) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
