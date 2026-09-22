import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { UiAuthGuard, tokensEqual } from './ui-auth.guard';

function context(headers: Record<string, string | undefined>): never {
  return { switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as never;
}

describe('UiAuthGuard', () => {
  it('closes the API when no token is configured, whatever the caller offers', () => {
    // The rule the route shares with /operations: unset is "not decided yet", and an undecided
    // deployment must not serve addresses and prices for convenience.
    const guard = new UiAuthGuard(() => undefined);
    expect(() => guard.canActivate(context({ authorization: 'Bearer anything' }))).toThrow(
      ServiceUnavailableException,
    );
    expect(() => guard.canActivate(context({}))).toThrow(ServiceUnavailableException);
  });

  it('refuses a missing header', () => {
    const guard = new UiAuthGuard(() => 'secret');
    expect(() => guard.canActivate(context({}))).toThrow(ForbiddenException);
  });

  it('refuses a wrong token', () => {
    const guard = new UiAuthGuard(() => 'secret');
    expect(() => guard.canActivate(context({ authorization: 'Bearer secret2' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context({ authorization: 'Bearer secre' }))).toThrow(ForbiddenException);
  });

  it('refuses the right token offered without the Bearer scheme', () => {
    const guard = new UiAuthGuard(() => 'secret');
    expect(() => guard.canActivate(context({ authorization: 'secret' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context({ authorization: 'Basic secret' }))).toThrow(ForbiddenException);
  });

  it('admits the configured token', () => {
    const guard = new UiAuthGuard(() => 'secret');
    expect(guard.canActivate(context({ authorization: 'Bearer secret' }))).toBe(true);
  });

  it('reads the token on every request rather than once', () => {
    // Rotation is one variable change on Railway; the guard must follow it without being rebuilt.
    let current: string | undefined = 'first';
    const guard = new UiAuthGuard(() => current);
    expect(guard.canActivate(context({ authorization: 'Bearer first' }))).toBe(true);
    current = 'second';
    expect(() => guard.canActivate(context({ authorization: 'Bearer first' }))).toThrow(ForbiddenException);
    expect(guard.canActivate(context({ authorization: 'Bearer second' }))).toBe(true);
    current = undefined;
    expect(() => guard.canActivate(context({ authorization: 'Bearer second' }))).toThrow(ServiceUnavailableException);
  });
});

describe('tokensEqual', () => {
  it('matches identical tokens and nothing else', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
    expect(tokensEqual('', 'a')).toBe(false);
    expect(tokensEqual('ção', 'ção')).toBe(true);
  });
});
