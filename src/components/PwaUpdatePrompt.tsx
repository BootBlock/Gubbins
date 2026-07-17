import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@/components/foundry';
import { usePwaUpdate, type DeployedVersion, type PwaUpdateApi } from '@/components/foundry/usePwaUpdate';
import { usePwaUpdateSnoozeStore } from '@/components/foundry/usePwaUpdateSnoozeStore';
import { RefreshIcon, WarningIcon } from '@/components/icons';
import { APP_SCHEMA_VERSION } from '@/lib/app-version';
import { compareVersions } from '@/lib/version-compare';
import { useT } from '@/features/i18n';

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
 * **Data-safety check (issue #74).** While Gubbins is pre-release (before 1.0) the on-disk
 * schema is not migrated forward, so *some* updates reset the user's data — and the banner must
 * not promise otherwise. When a worker is waiting the prompt fetches the incoming deploy's
 * {@link DeployedVersion} and compares its `schemaVersion` against the running build's
 * {@link APP_SCHEMA_VERSION}: matching → the reassuring "your data stays intact" copy; differing
 * → a warning that reloading will reset saved data (so the user can back up first); and if the
 * deploy's manifest can't be read, a neutral message that makes no promise either way.
 *
 * A user who isn't ready to reload has two ways out: dismiss ("remind me later") snoozes it for
 * ~8h via {@link usePwaUpdateSnoozeStore}; "Skip this version" hides it for this specific version
 * with no expiry — it re-appears only once a *newer* version is deployed. Both are device-local
 * (localStorage, mirroring saved searches — nothing synced). The snooze is honoured for its full
 * window even across reloads; only a genuinely *new* waiting worker that installs while the page
 * is open (a later `updateAvailableSeq` tick — the first tick of a session just re-announces the
 * worker we may have snoozed) re-surfaces the prompt before it expires.
 *
 * Mounted bare in the root layout chrome, clear of the bottom-left offline pill. The
 * update + version signals are read through the injectable {@link PwaUpdateApi} seam so this is
 * component-testable with a fake.
 */
export function PwaUpdatePrompt({ api }: { api?: PwaUpdateApi }) {
  const t = useT();
  const { needRefresh, updateAvailableSeq, update, fetchDeployedVersion } = usePwaUpdate(api);
  const snoozedUntil = usePwaUpdateSnoozeStore((s) => s.snoozedUntil);
  const skippedVersion = usePwaUpdateSnoozeStore((s) => s.skippedVersion);
  const snooze = usePwaUpdateSnoozeStore((s) => s.snooze);
  const skip = usePwaUpdateSnoozeStore((s) => s.skip);
  const surface = usePwaUpdateSnoozeStore((s) => s.surface);
  const [reloading, setReloading] = useState(false);
  // `undefined` = not fetched yet; `null` = couldn't be determined (offline/missing/malformed);
  // otherwise the incoming deploy's identity.
  const [deployed, setDeployed] = useState<DeployedVersion | null | undefined>(undefined);

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

  // Read the incoming deploy's identity whenever a worker is announced, so the banner can say
  // whether the update keeps the user's data. Re-fetch (clearing the previous answer) on each
  // new notification, since a genuinely newer worker may carry a different version.json.
  useEffect(() => {
    if (updateAvailableSeq === 0) return;
    let cancelled = false;
    setDeployed(undefined);
    void fetchDeployedVersion().then((result) => {
      if (!cancelled) setDeployed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [updateAvailableSeq, fetchDeployedVersion]);

  const snoozed = snoozedUntil > Date.now();
  if (!needRefresh || snoozed) return null;
  // With a skip on record, wait for the deploy's identity before deciding — otherwise a version
  // the user has already skipped would flash on screen before we could confirm and hide it.
  if (skippedVersion !== null && deployed === undefined) return null;
  const skipped =
    deployed != null && skippedVersion !== null && compareVersions(deployed.version, skippedVersion) <= 0;
  if (skipped) return null;

  // `deployed == null` covers both "still loading" and "couldn't determine" — both make no
  // promise about the data. A known deploy is compatible only when its schema matches ours.
  const willResetData = deployed != null && deployed.schemaVersion !== APP_SCHEMA_VERSION;
  const bodyKey = willResetData
    ? 'pwa.update.body.reset'
    : deployed != null
      ? 'pwa.update.body.compatible'
      : 'pwa.update.body.unknown';

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
        tone={willResetData ? 'warning' : 'info'}
        role="alert"
        data-testid="pwa-update-prompt"
        icon={willResetData ? <WarningIcon aria-hidden="true" /> : <RefreshIcon aria-hidden="true" />}
        heading={t('pwa.update.heading')}
        action={
          <Button
            size="sm"
            data-testid="pwa-reload-now"
            onClick={() => void reloadNow()}
            disabled={reloading}
          >
            {reloading ? t('pwa.update.reloading') : t('pwa.update.reload')}
          </Button>
        }
        onDismiss={() => snooze()}
        dismissLabel={t('pwa.update.remindLater')}
        dismissTestId="pwa-dismiss"
      >
        <p>{t(bodyKey)}</p>
        {deployed != null ? (
          <Button
            variant="link"
            size="sm"
            data-testid="pwa-skip-version"
            onClick={() => skip(deployed.version)}
            className="mt-1 h-auto p-0"
          >
            {t('pwa.update.skip')}
          </Button>
        ) : null}
      </Banner>
    </div>
  );
}
