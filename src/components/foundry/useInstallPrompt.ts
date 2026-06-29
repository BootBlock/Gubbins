/**
 * useInstallPrompt — capture the platform's `beforeinstallprompt` event so Gubbins
 * can offer a one-tap "Install" affordance (spec §2 "Must support installation to
 * Home Screen/Desktop"; §2 ephemeral-data persistence safeguard).
 *
 * On Chromium browsers the platform fires `beforeinstallprompt` when the PWA is
 * installable; the default mini-infobar is suppressed (`preventDefault`) and the
 * event stashed so we can trigger the native install dialog from our own UI later.
 * `appinstalled` (and an already-standalone launch) marks the app installed so the
 * affordance disappears. Where the event never fires (iOS/Safari, desktop Firefox)
 * `canInstall` stays `false` and callers fall back to manual guidance.
 *
 * The window-event + standalone-detection access goes through an injectable
 * {@link InstallPromptApi} seam (the `useWakeLock` `apiOverride` pattern) so the hook
 * is component-testable with a fake (no real browser, no real install dialog).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isStandaloneDisplay } from '@/lib/env/install';

/** The slice of the (non-standard) `beforeinstallprompt` event we depend on. */
export interface BeforeInstallPromptEventLike {
  preventDefault(): void;
  /** Show the native install dialog. Single-use: usable at most once per event. */
  prompt(): Promise<void>;
}

/** Callbacks the seam invokes when the platform fires the relevant window events. */
export interface InstallPromptHandlers {
  onPrompt(event: BeforeInstallPromptEventLike): void;
  onInstalled(): void;
}

/** Injectable seam over the install window events + standalone detection. */
export interface InstallPromptApi {
  /** Whether the app is already running as an installed / standalone PWA. */
  isStandalone(): boolean;
  /** Subscribe to install events; returns an unsubscribe function. */
  subscribe(handlers: InstallPromptHandlers): () => void;
}

/** The real browser seam: `window` events + the standalone display-mode probe. */
export function browserInstallPromptApi(): InstallPromptApi {
  return {
    isStandalone: () => isStandaloneDisplay(),
    subscribe: (handlers) => {
      if (typeof window === 'undefined') return () => {};
      const onPrompt = (event: Event) =>
        handlers.onPrompt(event as unknown as BeforeInstallPromptEventLike);
      const onInstalled = () => handlers.onInstalled();
      window.addEventListener('beforeinstallprompt', onPrompt);
      window.addEventListener('appinstalled', onInstalled);
      return () => {
        window.removeEventListener('beforeinstallprompt', onPrompt);
        window.removeEventListener('appinstalled', onInstalled);
      };
    },
  };
}

export interface InstallPromptState {
  /** A native install dialog can be shown right now (installable, not yet installed). */
  readonly canInstall: boolean;
  /** The app is already installed / running standalone. */
  readonly installed: boolean;
  /** Trigger the native install dialog (no-op if not installable). */
  promptInstall(): Promise<void>;
}

/**
 * Track PWA installability live. Pass a fake `apiOverride` in tests; production
 * callers use the default browser seam.
 */
export function useInstallPrompt(apiOverride?: InstallPromptApi): InstallPromptState {
  // Resolve the seam once (per override identity) so the effect deps stay stable.
  const api = useMemo(() => apiOverride ?? browserInstallPromptApi(), [apiOverride]);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEventLike | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => api.isStandalone());

  useEffect(() => {
    // Re-sync in case the value changed between the initial render and this effect.
    setInstalled(api.isStandalone());
    const unsubscribe = api.subscribe({
      onPrompt: (event) => {
        // Suppress the browser's default mini-infobar; we surface our own affordance.
        event.preventDefault();
        setDeferred(event);
      },
      onInstalled: () => {
        setInstalled(true);
        setDeferred(null);
      },
    });
    return unsubscribe;
  }, [api]);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
    } finally {
      // The captured event is single-use whatever the user chose.
      setDeferred(null);
    }
  }, [deferred]);

  return { canInstall: deferred !== null && !installed, installed, promptInstall };
}
