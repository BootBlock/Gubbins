import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@/components/foundry';
import { usePwaUpdate, type PwaUpdateApi } from '@/components/foundry/usePwaUpdate';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import { CloseIcon, RefreshIcon } from '@/components/icons';

/**
 * "A new version is ready" prompt (spec §2 installable/offline-first PWA).
 *
 * Gubbins updates in `prompt` mode (see vite.config.ts): a newer build installs in the
 * background but waits — it never activates or reloads the page on its own, so the
 * user's unsaved, in-flight work on the current page is never discarded by a deploy.
 * When an update is waiting this surfaces a non-blocking banner; only when the user
 * clicks "Reload now" does {@link usePwaUpdate.update} hand control to the new worker,
 * which reloads onto the new version. Until then the current page keeps running as-is.
 *
 * A user who isn't ready to reload can instead dismiss the banner ("remind me later"),
 * which snoozes it for ~8h via {@link usePwaUpdateSnoozeStore} (a device-local localStorage
 * store, mirroring saved searches — nothing synced). The snooze is honoured for its full
 * window even across reloads; only a genuinely *new* waiting worker that installs while the
 * page is open (a later `updateAvailableSeq` tick — the first tick of a session just
 * re-announces the worker we may have snoozed) re-surfaces the prompt before it expires.
 *
 * Mounted bare in the root layout chrome, clear of the bottom-left offline pill. The
 * update signal is read through the injectable {@link PwaUpdateApi} seam so this is
 * component-testable with a fake.
 */
export function PwaUpdatePrompt({ api }: { api?: PwaUpdateApi }) {
  const { needRefresh, updateAvailableSeq, update } = usePwaUpdate(api);
  const snoozedUntil = usePwaUpdateSnoozeStore((s) => s.snoozedUntil);
  const snooze = usePwaUpdateSnoozeStore((s) => s.snooze);
  const surface = usePwaUpdateSnoozeStore((s) => s.surface);
  const [reloading, setReloading] = useState(false);

  // A snooze ("remind me later") is honoured for its full window even across reloads. The
  // FIRST waiting-worker notification of a session just re-announces the worker we already
  // know about (and may have snoozed on a previous load), so it must NOT clear the snooze.
  // Only a *subsequent* notification — a genuinely newer worker installing while the page is
  // already open — overrides the snooze and re-surfaces the prompt early. The ref tracks the
  // last seen sequence; `prevSeqRef.current === 0` means "no notification seen yet this
  // session", i.e. the next tick is that harmless first announcement.
  const prevSeqRef = useRef(updateAvailableSeq);
  useEffect(() => {
    if (updateAvailableSeq > prevSeqRef.current) {
      const isFirstOfSession = prevSeqRef.current === 0;
      prevSeqRef.current = updateAvailableSeq;
      if (!isFirstOfSession) surface();
    }
  }, [updateAvailableSeq, surface]);

  const snoozed = snoozedUntil > Date.now();
  if (!needRefresh || snoozed) return null;

  async function reloadNow() {
    setReloading(true);
    try {
      // Resolves into a page reload onto the new version; on the off chance it returns
      // without navigating, drop the disabled state so the user can retry.
      await update(true);
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 mx-auto w-full max-w-md px-4">
      <Banner
        tone="info"
        role="alert"
        data-testid="pwa-update-prompt"
        icon={<RefreshIcon aria-hidden="true" />}
        heading="A new version is ready"
        action={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              data-testid="pwa-reload-now"
              onClick={() => void reloadNow()}
              disabled={reloading}
            >
              {reloading ? 'Reloading…' : 'Reload now'}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss update notice"
              data-testid="pwa-dismiss"
              onClick={() => snooze()}
            >
              <CloseIcon aria-hidden="true" />
            </Button>
          </div>
        }
      >
        Reload to get the latest update. Your saved data stays intact — finish anything
        in progress first, then reload when you&apos;re ready.
      </Banner>
    </div>
  );
}
