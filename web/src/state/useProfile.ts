import { useCallback, useState } from 'react';
import type { ProfileSummary } from '@shared/api-types';

const PROFILE_KEY = 'rental-ui-profile';

/** Which profile's scores to show. Remembered per browser; falls back to the first active one. */
export function useProfile(profiles: ProfileSummary[]): [string, (id: string) => void] {
  const [chosen, setChosen] = useState<string>(() => {
    try {
      return localStorage.getItem(PROFILE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const valid = profiles.some((p) => p.id === chosen) ? chosen : (profiles[0]?.id ?? '');
  const set = useCallback((id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(PROFILE_KEY, id);
    } catch {
      // Remembering the choice is a convenience; failing to is not an error.
    }
  }, []);
  return [valid, set];
}
