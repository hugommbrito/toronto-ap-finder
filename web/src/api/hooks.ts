import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiFetch } from './client';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  /** Patch what is shown without a round trip — used after a state change is confirmed. */
  setData: (update: (previous: T | null) => T | null) => void;
}

/**
 * One GET, re-run whenever the path changes, cancelled if it changes again first.
 *
 * The previous data stays on screen while the next page loads: the list going blank between
 * every filter change is worse than a stale list with a loading mark. A null path means
 * "nothing to fetch" and clears everything.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<T>(path, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : 'falha de rede'));
        setLoading(false);
      });
    return () => controller.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((update: (previous: T | null) => T | null) => setData(update), []);

  return { data, error, loading, reload, setData: patch };
}
