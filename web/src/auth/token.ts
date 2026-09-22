import { useSyncExternalStore } from 'react';

/**
 * The bearer token, kept in localStorage so a phone stays signed in.
 *
 * Also held in memory, because a private window can refuse localStorage entirely — the session
 * then lasts as long as the tab, which is better than not being able to sign in at all.
 */
const TOKEN_KEY = 'rental-ui-token';
const listeners = new Set<() => void>();
let memoryToken: string | null = null;
let authMessage: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string | null, message: string | null = null): void {
  memoryToken = token;
  authMessage = message;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage refused; the in-memory copy carries the session for this tab.
  }
  emit();
}

function getAuthMessage(): string | null {
  return authMessage;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToken(): string | null {
  return useSyncExternalStore(subscribe, getToken, () => null);
}

/** Why the last token was dropped — shown on the login screen, once. */
export function useAuthMessage(): string | null {
  return useSyncExternalStore(subscribe, getAuthMessage, () => null);
}
