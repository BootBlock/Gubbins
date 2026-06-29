/**
 * useApplyTheme — keep the document theme class in sync with the Tier-2 preference.
 *
 * Mounted once at the composition root. `main.tsx` also applies the persisted theme
 * synchronously before first paint to avoid a flash; this hook handles every later
 * change (e.g. the Settings toggle) reactively. When the preference is `'system'` it
 * also listens for OS `prefers-color-scheme` changes and re-applies live.
 */
import { useEffect } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { applyTheme, PREFERS_DARK_QUERY } from './theme';

export function useApplyTheme(): void {
  const theme = usePreferencesStore((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
    // Only the 'system' theme tracks the OS; an explicit choice needs no listener.
    if (theme !== 'system' || typeof matchMedia !== 'function') return;
    const media = matchMedia(PREFERS_DARK_QUERY);
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);
}
