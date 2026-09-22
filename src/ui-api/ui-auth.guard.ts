import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Where the guard reads its token from.
 *
 * An injection token rather than a direct `loadEnv()` call, because `loadEnv()` caches its first
 * parse for the life of the process — a guard that read it directly could only ever be tested
 * against one configuration. The module wires this to the environment; a test hands in a closure.
 */
export const UI_TOKEN_SOURCE = Symbol('UI_TOKEN_SOURCE');
export type TokenSource = () => string | undefined;

/**
 * Bearer token for the browser UI's `/api` routes.
 *
 * Same rule as `OperationsController`: an unset token closes the routes (503) rather than opening
 * them. These pages list addresses and prices, and the README's terms are personal use with no
 * public exposure. It is a separate token from OPERATIONS_TOKEN so that being allowed to read
 * listings does not also mean being allowed to read failure detail — the two readers are not the
 * same people.
 */
@Injectable()
export class UiAuthGuard implements CanActivate {
  constructor(@Inject(UI_TOKEN_SOURCE) private readonly readToken: TokenSource) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.readToken();
    if (!expected) {
      throw new ServiceUnavailableException('UI_TOKEN is not set; the UI API stays closed until it is');
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const header = request.headers.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    const offered = raw?.startsWith('Bearer ') ? raw.slice('Bearer '.length) : null;

    if (offered === null || !tokensEqual(offered, expected)) {
      throw new ForbiddenException('bad or missing bearer token');
    }
    return true;
  }
}

/** Constant-time once the lengths agree; the length itself is not a secret. */
export function tokensEqual(offered: string, expected: string): boolean {
  const a = Buffer.from(offered, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
