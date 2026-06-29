/**
 * useOnlineStatus — track network connectivity live (spec §2 local-first /
 * offline-first PWA). Gubbins is fully functional offline, so this drives a
 * *reassuring* indicator ("changes are saved locally") rather than gating any
 * feature; it also lets the sync UI reflect when a peer is actually reachable.
 *
 * The window-event access goes through an injectable {@link OnlineStatusApi} seam
 * (the `useInstallPrompt` / `useWakeLock` `apiOverride` pattern) so the hook is
 * component-testable with a fake — no real browser, no real network toggling.
 */
import { useEffect, useMemo, useState } from 'react';
import { isOnline } from '@/lib/env/network';

/** Injectable seam over the connectivity probe + `online`/`offline` window events. */
export interface OnlineStatusApi {
  /** Whether the browser currently believes it is online. */
  isOnline(): boolean;
  /** Subscribe to connectivity changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** The real browser seam: `navigator.onLine` + the `online`/`offline` window events. */
export function browserOnlineStatusApi(): OnlineStatusApi {
  return {
    isOnline: () => isOnline(),
    subscribe: (listener) => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
  };
}

/**
 * Returns whether the app is currently online, updating on connectivity changes.
 * Pass a fake `apiOverride` in tests; production callers use the default seam.
 */
export function useOnlineStatus(apiOverride?: OnlineStatusApi): boolean {
  // Resolve the seam once (per override identity) so the effect deps stay stable.
  const api = useMemo(() => apiOverride ?? browserOnlineStatusApi(), [apiOverride]);
  const [online, setOnline] = useState<boolean>(() => api.isOnline());

  useEffect(() => {
    // Re-sync in case connectivity changed between the initial render and this effect.
    setOnline(api.isOnline());
    return api.subscribe(() => setOnline(api.isOnline()));
  }, [api]);

  return online;
}
