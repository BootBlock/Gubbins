import { useEffect, useId, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Banner,
  Button,
  Checkbox,
  FormField,
  Input,
  LiveRegion,
  PageContainer,
  PageHeader,
  Surface,
  Tooltip,
  buttonVariants,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  ArchiveIcon,
  CloudIcon,
  CloudUploadIcon,
  ConnectIcon,
  DisconnectIcon,
  FolderSyncIcon,
  SyncIcon,
  VoiceIcon,
  InfoIcon,
  WarningIcon,
} from '@/components/icons';
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { BackupDialog } from '@/features/backup/BackupDialog';
import { canAny } from '@/features/users/permissions';
import { adoptAuthorityChange } from '@/features/users/authority-refresh';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { consumeRestoreNotice, type RestoreNotice } from '@/features/backup/restore-backup';
import { SettingsGroupPicker } from '@/features/backup/SettingsGroupPicker';
import { LIVE_SYNCABLE_SETTINGS_GROUP_IDS } from '@/features/backup/settings-groups';
import { applySharedSettings, flushSettingsSync } from '@/features/settings/settings-sync-runtime';
import { buildPushSnapshotJson, pushSnapshotToBridge } from './push-to-bridge';
import { checkBridgeBuild, type BridgeBuildCheckResult } from './bridge-build-check';
import type { BridgeVersionStatus } from './bridge-version';
import { useT } from '@/features/i18n';
import { MemoryCloudProvider } from './providers/memory-provider';
import {
  connectFileSystemProvider,
  forgetFileSystemProvider,
  reconnectFileSystemProvider,
} from './providers/file-system-provider';
import { isGoogleDriveConfigured } from './providers/google-config';
import {
  connectGoogleDrive,
  forgetGoogleDrive,
  reconnectGoogleDrive,
} from './providers/google-drive-provider';
import { GoogleApiError } from './providers/google-drive-api';
import { consumeGoogleAuthError } from './providers/google-oauth';
import { getActiveProvider, getSyncDriver, setActiveProvider } from './runtime';
import { runSync, type SyncResult } from './sync-engine';
import { SyncPushFailedError, SyncRemoteMissingError } from './sync-errors';
import { describeSyncOutcome } from './sync-status-format';
import { httpTimeSource } from './time-source';
import { useSyncConflictsStore } from './conflict-store';
import { SyncConflictsDialog } from './SyncConflictsDialog';
import { BridgeReloadNotice } from './BridgeReloadNotice';
import { useErrorMessage } from '@/features/errors';

/**
 * The catalog key describing each out-of-date verdict (issue #282). An explicit map rather than
 * an interpolated key, so the typed `t()` seam can still check every one of them exists.
 */
const BRIDGE_BUILD_MESSAGE_KEYS = {
  'schema-behind': 'sync.bridge.build.schemaBehind',
  behind: 'sync.bridge.build.behind',
  ahead: 'sync.bridge.build.ahead',
  unknown: 'sync.bridge.build.unknown',
} as const satisfies Record<Exclude<BridgeVersionStatus, 'current'>, string>;

/**
 * The verdicts that are a note rather than a warning: the bridge is reading the data correctly,
 * it is just not the same release. Everything else may be misreading it, which is louder.
 */
const BRIDGE_BUILD_INFORMATIONAL = new Set<BridgeVersionStatus>(['behind', 'ahead']);

/**
 * The Cloud Sync & File System Access hub (spec §2 Initial Handshake, §7, Phase 7).
 *
 * Hosts the provider-agnostic handshake (an in-memory test provider and a File System
 * Access "sync folder" — no cloud SDK, per §1.2), a one-tap sync, and the §2 versioned
 * JSON backup/restore. Browser-only APIs are feature-detected; sync results (incl. the
 * §7.4 Hard Stop, §7.5 re-parents and cycle rejections) are surfaced to the user.
 */
export function SyncScreen() {
  const client = useQueryClient();
  const auth = useAuthStore();
  const fmt = useFormatters();
  const t = useT();
  const {
    bridgeUrl,
    bridgeToken,
    setBridgeUrl,
    setBridgeToken,
    settingsSyncEnabled,
    settingsSyncGroups,
    setSettingsSyncEnabled,
    setSettingsSyncGroups,
  } = usePreferencesStore();
  const [connected, setConnected] = useState(getActiveProvider() !== null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  // A one-off banner at the top of the screen. Carries its own tone because a restore can land
  // and still leave something out, and that is not news to say in the success voice (#639).
  const [notice, setNotice] = useState<RestoreNotice | null>(null);
  /** The ordinary "that worked" banner — anything with a tone of its own sets `notice` directly. */
  const showInfo = (message: string) => setNotice({ message, tone: 'info' });
  const [reconnectable, setReconnectable] = useState(false);
  const [googleReconnectable, setGoogleReconnectable] = useState(false);
  // Issue #196: the shared snapshot has gone missing on a device that has synced before, so
  // the sync stopped short of overwriting it. Offers an explicit republish.
  const [remoteMissing, setRemoteMissing] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const authority = useSessionStore((state) => state.authority);
  const mayUseBackup = canAny(authority, ['backup:read', 'backup:write']);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  // Issue #72: device-local record of edits a sync overwrote — surfaced for review below.
  const conflictCount = useSyncConflictsStore((s) => s.conflicts.length);
  // Push-to-bridge outcome shown inline beside the "Push now" button (rather than a
  // top-of-page banner far from where the user is looking).
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Issue #282: whether the configured bridge is as up-to-date as this app. The bridge has no
  // auto-update, so a checkout left behind by a `git pull` that never happened is otherwise
  // completely invisible from here.
  const [buildCheck, setBuildCheck] = useState<BridgeBuildCheckResult | null>(null);
  // Issue #382: how many shared preferences the last sync brought in from another device. Kept
  // separate from the sync outcome line so an adopted setting is reported where the user chose it.
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const settingsSyncHintId = useId();

  // Surface a one-off success message after a backup restore reloaded the app.
  useEffect(() => {
    const restored = consumeRestoreNotice();
    if (restored) setNotice(restored);
  }, []);

  // Ask the configured bridge which build it is, once on arrival (issue #282).
  //
  // Read from the store rather than the render-scope values so this is genuinely mount-only:
  // keying it on the URL/token fields would fire a request at a half-typed host on every
  // keystroke. An unreachable bridge simply yields no opinion — the screen already has its own
  // way of saying "we couldn't reach it", and two messages for one problem is noise.
  useEffect(() => {
    const { bridgeUrl: url, bridgeToken: token } = usePreferencesStore.getState();
    if (url.trim() === '' || token.trim() === '') return;

    let cancelled = false;
    void checkBridgeBuild(url, token, (u, init) => fetch(u, init)).then((outcome) => {
      if (!cancelled) setBuildCheck(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fsSupported = hasFileSystemAccess();
  const driveConfigured = isGoogleDriveConfigured();

  // Resume the previously-chosen provider across sessions, and complete a Google Drive
  // sign-in that has just redirected back (the token was stored at app entry, so a live
  // token here means "freshly connected" or "still valid").
  //  - Google Drive: a live token reconnects silently; an expired/absent token for a
  //    returning Google user offers a "Reconnect Google Drive" sign-in.
  //  - File System (Phase 14): reconnect only while the OS permission still stands; a handle
  //    needing a fresh grant surfaces a "Reconnect folder" button (the re-grant needs a gesture).
  useEffect(() => {
    if (getActiveProvider() !== null) return;
    let cancelled = false;

    // Surface a one-off error from a cancelled/failed Google redirect (CSRF or denied).
    const authErr = consumeGoogleAuthError();
    if (authErr) setError(googleAuthErrorMessage(authErr));

    if (auth.providerId === 'file-system') {
      void reconnectFileSystemProvider(false).then((res) => {
        if (cancelled) return;
        if (res.provider) {
          connect({ id: res.provider.id, label: res.provider.label }, res.provider);
        } else if (res.needsGesture) {
          setReconnectable(true);
        }
      });
    } else if (auth.providerId === 'google-drive' || auth.providerId === null) {
      // 'google-drive' resumes a stored session; null + a freshly-stored token is the
      // just-redirected-back connect. A different provider (e.g. 'memory') is left alone so
      // a stale token can never hijack it.
      const google = reconnectGoogleDrive(auth.providerId === 'google-drive');
      if (google.provider) {
        connect({ id: google.provider.id, label: google.provider.label }, google.provider);
      } else if (google.needsAuth) {
        setGoogleReconnectable(true);
      }
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reconnectFolder() {
    setError(null);
    const res = await reconnectFileSystemProvider(true);
    if (res.provider) {
      setReconnectable(false);
      connect({ id: res.provider.id, label: res.provider.label }, res.provider);
    } else {
      setError('Could not re-grant access to the sync folder. Pick it again.');
    }
  }

  function connect(
    provider: { id: string; label: string },
    instance: NonNullable<ReturnType<typeof getActiveProvider>>,
  ) {
    setActiveProvider(instance);
    auth.setProvider(provider.id, provider.label);
    setConnected(true);
    setError(null);
    // A different remote is now in play, so a missing-copy warning about the old one is stale.
    setRemoteMissing(false);
    showInfo(`Connected to ${provider.label}.`);
  }

  function connectMemory() {
    const provider = new MemoryCloudProvider();
    connect({ id: provider.id, label: provider.label }, provider);
  }

  async function connectFolder() {
    setError(null);
    const provider = await connectFileSystemProvider();
    if (!provider) {
      setError('No folder was selected, or the File System Access API is unavailable.');
      return;
    }
    connect({ id: provider.id, label: provider.label }, provider);
  }

  /** Begin the Google sign-in redirect; the tab navigates to Google and resumes on return. */
  function connectGoogle() {
    setError(null);
    connectGoogleDrive();
  }

  function disconnect() {
    setActiveProvider(null);
    auth.disconnect();
    setConnected(false);
    setReconnectable(false);
    setGoogleReconnectable(false);
    setRemoteMissing(false);
    setResult(null);
    void forgetFileSystemProvider(); // drop the persisted folder handle (Phase 14)
    forgetGoogleDrive(); // drop the stored Google token
    showInfo('Disconnected.');
  }

  /**
   * Adopt everything a completed merge has already written to the local database.
   *
   * Deliberately independent of whether the *push* succeeded (issue #638): `mergeSnapshot`
   * applies the reconciliation plan and re-reads it, so by the time the upload is attempted the
   * remote's upserts and deletions are durable here. Skipping this on a failed push discards the
   * conflict records for good — the local edits they describe have already been overwritten, so
   * no later sync can detect them again — and leaves every screen rendering rows the merge has
   * just changed or removed.
   */
  async function adoptMergedState(outcome: SyncResult) {
    // Issue #72: record any of the user's edits this sync overwrote, so they can review
    // and recover them from the Conflicts section below rather than losing them silently.
    useSyncConflictsStore.getState().add(outcome.conflicts);
    // Issue #382: the merge has just resolved every shared preference against the other
    // devices' timestamps, so adopt whichever values won. A failure here must not turn a
    // successful data sync into an error — the settings simply stay as they were.
    try {
      const adopted = await applySharedSettings();
      if (adopted > 0) setSettingsNotice(t('sync.settings.adopted', { vars: { count: adopted } }));
    } catch (settingsError) {
      console.error('[gubbins] could not apply shared settings', settingsError);
    }
    // Issue #631: the merge may have brought a role change, a disabled account or a deletion
    // from another device, and `users`/`roles` are synced tables like any other. Re-resolve the
    // session's permissions before the refetches, or this device keeps writing under the ones it
    // signed in with until it is reloaded.
    await adoptAuthorityChange(client);
  }

  /**
   * Issue #196: `allowRemoteReset` republishes this device's data as a *new* shared copy
   * after the shared one has gone missing. Only ever passed from the confirm button below —
   * never on the ordinary "Sync now" path, where a missing remote must stop the sync.
   */
  async function syncNow(allowRemoteReset = false) {
    const provider = getActiveProvider();
    if (!provider) {
      setError('Connect a sync provider first.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setSettingsNotice(null);
    setRemoteMissing(false);
    try {
      // The engine's missing-remote guard keys off `sync_meta`, which is device-global: it still
      // reads "has synced" after the user connects a brand-new folder or account, so a genuinely
      // fresh remote would be reported as one that had gone missing. `lastSyncedAt` is the
      // per-connection answer (cleared when a different remote is connected), and a connection
      // that has never synced has no shared state to lose by publishing.
      const remoteNeverSynced = auth.lastSyncedAt === null;
      // Issue #382: a shared preference changed a moment ago is still queued for its row write, so
      // wait for those to land before the snapshot is read. Without this the change would sit out
      // this sync and travel in the next one — and worse, a peer's older value could win in between.
      await flushSettingsSync();
      const outcome = await runSync(getSyncDriver(), provider, {
        serverTime: httpTimeSource,
        allowRemoteReset: allowRemoteReset || remoteNeverSynced,
      });
      setResult(outcome);
      if (outcome.status === 'HARD_STOP') {
        setError(outcome.message ?? 'Sync was halted by the storage Hard Stop.');
      } else {
        auth.markSynced();
        await adoptMergedState(outcome);
      }
    } catch (err) {
      // Issue #638: a push that failed *after* the merge committed carries what already landed
      // locally. Adopt it before reporting, whichever branch below ends up explaining the
      // failure — the conflict records it produced are the only trace of the edits it
      // overwrote, and no later sync can re-detect them. `markSynced` deliberately does *not*
      // run: the shared copy was never updated, so this device is not up to date with it.
      const pushFailure = err instanceof SyncPushFailedError ? err : null;
      if (pushFailure) {
        setResult(pushFailure.localOutcome);
        await adoptMergedState(pushFailure.localOutcome);
      }
      // Report on what actually went wrong: for a failed push that is the transport error the
      // upload raised, so an expired token still reaches the reconnect path below rather than a
      // dead-end "publishing failed" the user can do nothing about.
      const cause = pushFailure ? pushFailure.cause : err;

      // A rejected/expired Google token drops us back to the reconnect path rather than a
      // bare error, so one click re-authorises and resumes.
      if (cause instanceof GoogleApiError && cause.isAuthError) {
        setActiveProvider(null);
        forgetGoogleDrive();
        setConnected(false);
        setGoogleReconnectable(true);
        setError('Your Google Drive sign-in expired. Reconnect to resume syncing.');
      } else if (cause instanceof SyncRemoteMissingError) {
        // The shared copy has vanished. Explain it, and offer the deliberate republish rather
        // than leaving the user with a sync that can never succeed again. The catalog copy is
        // used in preference to the error's own sentence so the whole banner is translated.
        setError(t('sync.remoteMissing.error'));
        setRemoteMissing(true);
      } else if (pushFailure) {
        // Say which half failed. "Sync failed" reads as "nothing happened", and the user's
        // screens have in fact just changed underneath them.
        setError(t('sync.pushFailed.error'));
      } else {
        setError(describeError(err, 'Sync failed.'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function pushToBridge() {
    setBusy(true);
    // Clear any stale top banner from another action; the push outcome shows inline below.
    setError(null);
    setNotice(null);
    setPushResult(null);
    try {
      const json = await buildPushSnapshotJson(getSyncDriver());
      const result = await pushSnapshotToBridge({
        baseUrl: bridgeUrl,
        token: bridgeToken,
        json,
        fetchImpl: (url, init) => fetch(url, init),
      });
      setPushResult({ ok: result.ok, message: result.message });
      // A successful push just proved the bridge is reachable, so re-read its build: this is
      // the moment a stale bridge matters most, and it also picks up a bridge the user has
      // updated and restarted since the screen mounted.
      if (result.ok) {
        setBuildCheck(await checkBridgeBuild(bridgeUrl, bridgeToken, (u, init) => fetch(u, init)));
      }
    } catch (err) {
      setPushResult({ ok: false, message: describeError(err, 'Push failed.') });
    } finally {
      setBusy(false);
    }
  }

  const canPush = bridgeUrl.trim().length > 0 && bridgeToken.trim().length > 0;
  const configuredButOffline = !connected && auth.providerId !== null && !googleReconnectable;

  return (
    <PageContainer>
      <PageHeader icon={<CloudIcon />} title="Cloud Sync & backups" />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {/* Errors interrupt (assertive); a sync/restore/backup failure the user must hear
          now. role="alert" also announces reliably on insertion, unlike a polite status. */}
        {error ? (
          <Banner tone="danger" role="alert" data-testid="sync-error">
            {error}
          </Banner>
        ) : null}
        {/* Issue #196: the shared copy has gone missing, so the sync stopped rather than
          replace it. Recovering is the user's call — reconnecting the right folder/account
          is usually what they want, so publishing this device's data is the second option
          and takes an explicit click. */}
        {remoteMissing ? (
          <Banner tone="warning" data-testid="sync-remote-missing">
            <div className="space-y-2">
              <p>{t('sync.remoteMissing.body')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void syncNow(true)}
                disabled={busy}
                data-testid="republish-snapshot"
              >
                <CloudUploadIcon />
                {t('sync.remoteMissing.republish')}
              </Button>
            </div>
          </Banner>
        ) : null}
        {notice ? (
          <Banner tone={notice.tone} data-testid="sync-notice">
            {notice.message}
          </Banner>
        ) : null}

        {/* Initial Handshake */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Connection</h2>
          {connected ? (
            <Surface className="flex flex-wrap items-center gap-3 p-4">
              <span className="grid size-9 place-items-center rounded-xl bg-success/15 text-success [&_svg]:size-5">
                <CloudIcon />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium" data-testid="sync-provider-label">
                  {auth.providerLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  {auth.lastSyncedAt ? `Last synced ${fmt.dateTime(auth.lastSyncedAt)}` : 'Not yet synced.'}
                </p>
              </div>
              <Tooltip
                content="Stop syncing and forget this provider. Your local inventory is untouched; the synced copy stays in place."
                triggerTabIndex={-1}
              >
                <span>
                  <Button variant="outline" size="sm" onClick={disconnect}>
                    <DisconnectIcon />
                    Disconnect
                  </Button>
                </span>
              </Tooltip>
            </Surface>
          ) : (
            <Surface className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">
                Choose where to synchronise. Gubbins is provider-agnostic — sign in to
                <strong> Google Drive</strong> (an app-private folder), connect a local folder (shared via
                your own cloud drive), or use the in-memory provider to try it out.
              </p>
              {reconnectable ? (
                <Banner tone="info">
                  <div className="space-y-2">
                    <p>
                      Found your previous sync folder ({auth.providerLabel}). Re-grant access to resume
                      syncing through it.
                    </p>
                    <Button size="sm" onClick={reconnectFolder} data-testid="reconnect-folder">
                      <FolderSyncIcon />
                      Reconnect folder
                    </Button>
                  </div>
                </Banner>
              ) : googleReconnectable ? (
                <Banner tone="info">
                  <div className="space-y-2">
                    <p>Your Google Drive sign-in has expired. Reconnect to resume syncing.</p>
                    <Button size="sm" onClick={connectGoogle} data-testid="reconnect-google-drive">
                      <CloudIcon />
                      Reconnect Google Drive
                    </Button>
                  </div>
                </Banner>
              ) : configuredButOffline ? (
                <Banner tone="warning">
                  Previously connected to {auth.providerLabel}. Reconnect to resume syncing.
                </Banner>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Tooltip
                  content={
                    driveConfigured
                      ? 'Sign in to Google to sync through an **app-private** folder in your Drive. Gubbins can only see that folder — never your other files.'
                      : 'Google Drive sync is not configured for this build. Set `VITE_GOOGLE_CLIENT_ID` and register your OAuth client (see docs/dev/google-drive-sync.md).'
                  }
                >
                  <span>
                    <Button
                      onClick={connectGoogle}
                      disabled={!driveConfigured}
                      data-testid="connect-google-drive"
                    >
                      <CloudIcon />
                      Google Drive…
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    fsSupported
                      ? 'Pick a folder to sync through (e.g. inside a cloud-drive mount).'
                      : 'This browser does not support the File System Access API.'
                  }
                >
                  <span>
                    <Button variant="outline" onClick={connectFolder} disabled={!fsSupported}>
                      <FolderSyncIcon />
                      Local folder…
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip content="Try the sync flow without a real backend — the **remote** lives only in this browser session. **Nothing is saved**: it doesn't persist across a reload and won't sync between devices. For trying it out, not for backups.">
                  <span>
                    <Button variant="outline" onClick={connectMemory} data-testid="connect-memory">
                      <ConnectIcon />
                      In-memory (test)
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </Surface>
          )}
        </section>

        {/* Sync */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Synchronise</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip
              content="Exchange changes both ways with the connected provider, merging newest-wins. Pauses automatically if local storage is critically full."
              triggerTabIndex={-1}
            >
              <span>
                {/* Wrapped, not passed directly: `onClick` would hand the click event to
                    `allowRemoteReset`, which is truthy — the exact overwrite this guards. */}
                <Button onClick={() => void syncNow()} disabled={!connected || busy} data-testid="sync-now">
                  <SyncIcon />
                  Sync now
                </Button>
              </span>
            </Tooltip>
            {/* Always-mounted polite region: the sync outcome appears in place after an
              explicit "Sync now", which a screen reader would otherwise miss (WCAG 4.1.3).
              The region must pre-exist for the later content change to be announced. */}
            <LiveRegion className="text-sm text-muted-foreground" data-testid="sync-result">
              {result && result.status !== 'HARD_STOP' ? describeSyncOutcome(result) : null}
            </LiveRegion>
          </div>
        </section>

        {/* Shared settings (issue #382) — opt in, per group, on this device. */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sync.settings.heading')}
          </h2>
          <Surface className="space-y-3 p-4">
            <div className="space-y-field-gap-compact">
              <label className="flex cursor-pointer items-start gap-3 text-sm font-medium text-foreground">
                <Checkbox
                  className="mt-0.5"
                  checked={settingsSyncEnabled}
                  onChange={(e) => setSettingsSyncEnabled(e.target.checked)}
                  aria-describedby={settingsSyncHintId}
                  data-testid="settings-sync-enabled"
                />
                {t('sync.settings.enable.label')}
              </label>
              {/* Described-by rather than part of the label: the paragraph explains the consequence,
                  which a screen reader should hear as a description, not as the control's name. */}
              <p id={settingsSyncHintId} className="pl-7 text-sm text-muted-foreground">
                {t('sync.settings.enable.hint')}
              </p>
            </div>
            <SettingsGroupPicker
              ids={LIVE_SYNCABLE_SETTINGS_GROUP_IDS}
              value={settingsSyncGroups}
              onChange={setSettingsSyncGroups}
              titleKey="sync.settings.chooseTitle"
              hintKey="sync.settings.chooseHint"
              emptyKey="sync.settings.none"
              testIdPrefix="settings-sync-group"
              disabled={!settingsSyncEnabled}
            />
            <p className="text-sm text-muted-foreground">{t('sync.settings.publishNote')}</p>
            {/* Always mounted so the count of settings a sync brought in is announced (WCAG 4.1.3). */}
            <LiveRegion className="text-sm text-muted-foreground" data-testid="settings-sync-result">
              {settingsNotice ? <p>{settingsNotice}</p> : null}
            </LiveRegion>
          </Surface>
        </section>

        {/* Conflicts — surfaced only when a sync overwrote one of the user's own edits (#72). */}
        {conflictCount > 0 ? (
          <section className="space-y-3" data-testid="sync-conflicts-section">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Conflicts</h2>
            <Banner
              tone="warning"
              icon={<WarningIcon />}
              heading={
                conflictCount === 1
                  ? 'One of your edits was overwritten'
                  : `${conflictCount} of your edits were overwritten`
              }
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConflictsOpen(true)}
                  data-testid="review-conflicts"
                >
                  Review…
                </Button>
              }
            >
              Another device changed the same thing at the same time, so newest-wins kept its version. Review
              each one to keep the current version or restore yours.
            </Banner>
          </section>
        ) : null}

        {/* Backup & restore — hidden outright for a role holding neither `backup:read` nor
            `backup:write`, because both actions behind it now refuse that session (issue #519). */}
        {mayUseBackup ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Backup &amp; restore
            </h2>
            <p className="text-sm text-muted-foreground">
              Save a complete backup — your inventory and records, full-resolution images, and settings — to a
              single file, then restore it later on this or another device. Choose exactly what to include.
            </p>
            <p className="text-sm text-muted-foreground">
              Gubbins stores its data separately in each browser, so this is also how you move your library
              between them — export here, then restore in the other browser (e.g. Firefox to Edge).
            </p>
            <Tooltip
              content="Create a complete `.zip` backup (data + images + settings) or restore a previously saved backup."
              triggerTabIndex={-1}
            >
              <span>
                <Button variant="outline" onClick={() => setBackupOpen(true)} data-testid="open-backup">
                  <ArchiveIcon />
                  Backup &amp; restore…
                </Button>
              </span>
            </Tooltip>
          </section>
        ) : null}

        {/* Push to bridge — for users without folder sync, hand the dataset straight to the
          optional Home Assistant query bridge over HTTP (the bridge re-hydrates it). */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Push to bridge
          </h2>
          <p className="text-sm text-muted-foreground">
            Send your whole inventory to a Gubbins query bridge (e.g. for Home Assistant) over your local
            network, without needing a shared folder. The bridge must have pushes enabled (
            <code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_ALLOW_PUSH=on</code>). Your URL and
            token are stored only on this device.
          </p>
          {/* Entry point to the interactive Home Assistant setup guide — the natural place to
            discover it, since the bridge and push settings it walks through live right here. The
            guide is a lazily-loaded route, so linking to it adds nothing to this screen's bundle. */}
          <Banner
            tone="info"
            icon={<VoiceIcon />}
            heading="Setting up Home Assistant voice control?"
            action={
              <Link
                to="/home-assistant"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                data-testid="open-ha-guide"
              >
                Open setup guide
              </Link>
            }
          >
            Follow the step-by-step guide to run the bridge, connect Home Assistant, and generate the access
            token — it walks you through every choice.
          </Banner>
          {/* Issue #385: a bridge address the app was not started with cannot be contacted until
            it reloads, and the browser reports that block as an ordinary network failure — so
            say so here, beside the field it is about, instead of letting "Push now" report a
            running bridge as unreachable. Renders nothing once the address is reachable. */}
          <BridgeReloadNotice />
          {/* Issue #282: the bridge never updates itself, so a checkout left behind is invisible
            unless we say so. Shown here, beside the connection it is about, rather than as a
            top-of-page banner. Silent when the bridge is current or unreachable. */}
          {buildCheck?.ok && buildCheck.status !== 'current' ? (
            <Banner
              // Only a bridge that may be *misreading* the data warrants a warning; a bridge that
              // is merely a release behind (or ahead) is reading it correctly, so it stays a note.
              tone={BRIDGE_BUILD_INFORMATIONAL.has(buildCheck.status) ? 'info' : 'warning'}
              icon={
                BRIDGE_BUILD_INFORMATIONAL.has(buildCheck.status) ? (
                  <InfoIcon aria-hidden="true" />
                ) : (
                  <WarningIcon aria-hidden="true" />
                )
              }
              heading={
                buildCheck.status === 'ahead'
                  ? t('sync.bridge.build.aheadHeading')
                  : t('sync.bridge.build.heading')
              }
              data-testid="bridge-build-notice"
            >
              {t(BRIDGE_BUILD_MESSAGE_KEYS[buildCheck.status], {
                vars: {
                  bridgeVersion: buildCheck.bridge?.version ?? '',
                  appVersion: buildCheck.app.version,
                },
              })}
            </Banner>
          ) : null}
          <Surface className="space-y-4 p-4">
            <FormField
              label="Bridge URL"
              hint="The bridge's base address on your network, e.g. `http://127.0.0.1:8787`. The snapshot endpoint is added automatically."
            >
              <Input
                type="url"
                inputMode="url"
                placeholder="http://127.0.0.1:8787"
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                data-testid="bridge-url"
              />
            </FormField>
            <FormField
              label="Access token"
              hint="An API token minted in Users → the account → API tokens. Treated as a secret — stored only on this device and never synced. Where accounts are in use, signing out forgets it."
            >
              <Input
                type="password"
                autoComplete="off"
                placeholder="Bridge access token"
                value={bridgeToken}
                onChange={(e) => setBridgeToken(e.target.value)}
                data-testid="bridge-token"
              />
            </FormField>
            <div className="flex flex-wrap items-center gap-3">
              <Tooltip
                content="Build a snapshot of everything and POST it to the bridge. It replaces the snapshot the bridge serves."
                triggerTabIndex={-1}
              >
                <span>
                  <Button onClick={pushToBridge} disabled={busy || !canPush} data-testid="push-to-bridge">
                    <CloudUploadIcon />
                    Push now
                  </Button>
                </span>
              </Tooltip>
              {!canPush ? (
                <span className="text-xs text-muted-foreground">
                  Enter the bridge URL and token to enable pushing.
                </span>
              ) : null}
              {/* The push outcome appears in place beside the button — close to where the
                user just clicked — rather than as a banner at the top they might miss. The
                region is always mounted so screen readers announce the later content change
                (WCAG 4.1.3), and errors interrupt (assertive) while successes queue (polite). */}
              <LiveRegion
                urgency={pushResult && !pushResult.ok ? 'assertive' : 'polite'}
                className={cn(
                  'text-sm',
                  pushResult ? (pushResult.ok ? 'text-glyph-success' : 'text-glyph-danger') : undefined,
                )}
                data-testid="push-result"
              >
                {pushResult ? pushResult.message : null}
              </LiveRegion>
            </div>
          </Surface>
        </section>
      </main>

      <BackupDialog
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        onRestored={(restored) => {
          // A reload-free restore replaces `users` and `roles` along with everything else, so the
          // session's permissions are re-resolved with the rest of the refresh (issue #631).
          void adoptAuthorityChange(client);
          setNotice(restored);
        }}
      />

      <SyncConflictsDialog
        open={conflictsOpen}
        onClose={() => setConflictsOpen(false)}
        onRestored={() => {
          // The restored version can be a `users` or `roles` row, so the same re-resolve applies
          // here as on the merge and restore paths (issue #631).
          void adoptAuthorityChange(client);
          showInfo('Your version was restored. It will sync to your other devices on the next sync.');
        }}
      />
    </PageContainer>
  );
}

/** Friendly message for an error code captured during the Google sign-in redirect. */
function googleAuthErrorMessage(code: string): string {
  if (code === 'access_denied') return 'Google sign-in was cancelled.';
  if (code === 'state_mismatch') {
    return 'Google sign-in could not be verified (the request did not match). Please try again.';
  }
  return 'Google sign-in did not complete. Please try again.';
}
