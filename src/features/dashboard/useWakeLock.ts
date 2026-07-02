/**
 * `useWakeLock` — hold the Screen Wake Lock while kiosk mode is on (spec §3).
 *
 * Keeps a hardwired dashboard/tablet awake during active monitoring. The decision of
 * *whether* to hold a lock at any moment is the pure {@link wakeLockAction}; this hook
 * is only the DOM glue that:
 *  - requests a `'screen'` sentinel when one is wanted,
 *  - releases it when kiosk mode is turned off or on unmount,
 *  - **re-acquires it on `visibilitychange`** — the browser auto-releases the sentinel
 *    when the page is hidden, so returning to a visible kiosk must re-request it.
 *
 * The Wake Lock API is reached through an injectable {@link WakeLockApi} seam so the
 * glue is unit-testable with a fake (no real browser), mirroring the scanner decoder
 * seam. A missing API or a rejected request degrades silently — never an unhandled
 * promise rejection (§3, §6.1).
 */
import { useEffect, useMemo } from 'react';
import { hasWakeLock } from '@/lib/env/feature-detection';
import { wakeLockAction } from './wake-lock';

/** The slice of `WakeLockSentinel` we depend on (kept minimal for the test fake). */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

/** Injectable seam over `navigator.wakeLock` so the hook is testable without a browser. */
export interface WakeLockApi {
  /** Whether the platform exposes the Screen Wake Lock API. */
  readonly supported: boolean;
  /** Request a `'screen'` wake sentinel. Rejects if the request is refused. */
  request(): Promise<WakeLockSentinelLike>;
}

interface NavigatorWakeLock {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

/** The real browser seam, feature-detected via {@link hasWakeLock}. */
export function browserWakeLockApi(): WakeLockApi {
  const supported = hasWakeLock();
  return {
    supported,
    request: () => {
      const nav = navigator as Navigator & NavigatorWakeLock;
      if (!nav.wakeLock) return Promise.reject(new Error('Wake Lock API unavailable'));
      return nav.wakeLock.request('screen');
    },
  };
}

/**
 * Hold a screen wake lock while `enabled` is true (and the platform supports it).
 *
 * @param enabled  the kiosk-mode preference.
 * @param apiOverride  a fake seam for tests; defaults to {@link browserWakeLockApi}.
 */
export function useWakeLock(enabled: boolean, apiOverride?: WakeLockApi): void {
  // Resolve the seam once (per override identity) so the effect deps stay stable.
  const api = useMemo(() => apiOverride ?? browserWakeLockApi(), [apiOverride]);

  useEffect(() => {
    if (!api.supported) return;

    // Local to the effect — a single sentinel handle, reconciled by wakeLockAction.
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    // The browser released our sentinel (e.g. the page was hidden). Drop the handle
    // so the next visibility change re-acquires.
    const onSentinelRelease = () => {
      sentinel = null;
    };

    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

    const sync = async () => {
      const action = wakeLockAction({
        enabled,
        supported: api.supported,
        visible: isVisible(),
        held: sentinel !== null,
      });
      if (action === 'acquire') {
        try {
          const next = await api.request();
          // The effect was torn down (or kiosk turned off) mid-request: undo it.
          if (cancelled || !enabled || !isVisible()) {
            void next.release().catch(() => {});
            return;
          }
          sentinel = next;
          next.addEventListener('release', onSentinelRelease);
        } catch {
          // Refused/unavailable — degrade silently (§3 graceful degradation).
        }
      } else if (action === 'release' && sentinel) {
        const current = sentinel;
        sentinel = null;
        current.removeEventListener('release', onSentinelRelease);
        void current.release().catch(() => {});
      }
    };

    const onVisibility = () => void sync();
    document.addEventListener('visibilitychange', onVisibility);
    void sync();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        const current = sentinel;
        sentinel = null;
        current.removeEventListener('release', onSentinelRelease);
        void current.release().catch(() => {});
      }
    };
  }, [enabled, api]);
}
