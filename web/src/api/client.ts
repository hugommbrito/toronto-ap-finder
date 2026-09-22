import { getToken, setToken } from '../auth/token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * fetch with the bearer token attached and the API's failures turned into one error type.
 *
 * A 401 or 403 drops the token: the server said this token is not one it knows, and keeping it
 * would only repeat the refusal. A 503 keeps it — that is the server saying *it* is not
 * configured, which no token fixes.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { ...init, headers });

  if (res.status === 401 || res.status === 403) {
    setToken(null, 'Token recusado. Confira o valor e tente de novo.');
    throw new ApiError(res.status, 'token recusado');
  }
  if (res.status === 503) {
    throw new ApiError(503, 'O servidor está sem UI_TOKEN configurado. Defina a variável e reinicie o serviço.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return (await res.json()) as T;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join('; ');
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Not JSON; fall through to the status line.
  }
  return `${res.status} ${res.statusText}`;
}
