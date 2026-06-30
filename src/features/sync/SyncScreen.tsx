import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, FormField, Input, LiveRegion, PageContainer, PageHeader, Surface, Tooltip, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  ArchiveIcon,
  CloudIcon,
  CloudUploadIcon,
  ConnectIcon,
  DisconnectIcon,
  FolderSyncIcon,
  SyncIcon,
} from '@/components/icons';
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import { useFormatters } from '@/lib/useFormatters';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { BackupDialog } from '@/features/backup/BackupDialog';
import { consumeRestoreNotice } from '@/features/backup/restore-backup';
import { buildPushSnapshotJson, pushSnapshotToBridge } from './push-to-bridge';
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
import { httpTimeSource } from './time-source';

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
  const { bridgeUrl, bridgeToken, setBridgeUrl, setBridgeToken } = usePreferencesStore();
  const [connected, setConnected] = useState(getActiveProvider() !== null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reconnectable, setReconnectable] = useState(false);
  const [googleReconnectable, setGoogleReconnectable] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);

  // Surface a one-off success message after a backup restore reloaded the app.
  useEffect(() => {
    const restored = consumeRestoreNotice();
    if (restored) setNotice(restored);
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

  function connect(provider: { id: string; label: string }, instance: NonNullable<ReturnType<typeof getActiveProvider>>) {
    setActiveProvider(instance);
    auth.setProvider(provider.id, provider.label);
    setConnected(true);
    setError(null);
    setNotice(`Connected to ${provider.label}.`);
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
    setResult(null);
    void forgetFileSystemProvider(); // drop the persisted folder handle (Phase 14)
    forgetGoogleDrive(); // drop the stored Google token
    setNotice('Disconnected.');
  }

  async function syncNow() {
    const provider = getActiveProvider();
    if (!provider) {
      setError('Connect a sync provider first.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await runSync(getSyncDriver(), provider, { serverTime: httpTimeSource });
      setResult(outcome);
      if (outcome.status === 'HARD_STOP') {
        setError(outcome.message ?? 'Sync was halted by the storage Hard Stop.');
      } else {
        auth.markSynced();
        await client.invalidateQueries();
      }
    } catch (err) {
      // A rejected/expired Google token drops us back to the reconnect path rather than a
      // bare error, so one click re-authorises and resumes.
      if (err instanceof GoogleApiError && err.isAuthError) {
        setActiveProvider(null);
        forgetGoogleDrive();
        setConnected(false);
        setGoogleReconnectable(true);
        setError('Your Google Drive sign-in expired. Reconnect to resume syncing.');
      } else {
        setError(err instanceof Error ? err.message : 'Sync failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function pushToBridge() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const json = await buildPushSnapshotJson(getSyncDriver());
      const result = await pushSnapshotToBridge({
        baseUrl: bridgeUrl,
        token: bridgeToken,
        json,
        fetchImpl: (url, init) => fetch(url, init),
      });
      if (result.ok) setNotice(result.message);
      else setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Push failed.');
    } finally {
      setBusy(false);
    }
  }

  const canPush = bridgeUrl.trim().length > 0 && bridgeToken.trim().length > 0;
  const configuredButOffline = !connected && auth.providerId !== null && !googleReconnectable;

  return (
    <PageContainer>
      <PageHeader icon={<CloudIcon />} title="Cloud Sync & backups" />

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-1 animate-rise flex-col gap-6 outline-none">
      {/* Errors interrupt (assertive); a sync/restore/backup failure the user must hear
          now. role="alert" also announces reliably on insertion, unlike a polite status. */}
      {error ? <Banner tone="danger" role="alert" data-testid="sync-error">{error}</Banner> : null}
      {notice ? <Banner tone="info" data-testid="sync-notice">{notice}</Banner> : null}

      {/* Initial Handshake */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Connection
        </h2>
        {connected ? (
          <Surface className="flex flex-wrap items-center gap-3 p-4">
            <span className="grid size-9 place-items-center rounded-xl bg-emerald-500/15 text-emerald-400 [&_svg]:size-5">
              <CloudIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium" data-testid="sync-provider-label">
                {auth.providerLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                {auth.lastSyncedAt
                  ? `Last synced ${fmt.dateTime(auth.lastSyncedAt)}`
                  : 'Not yet synced.'}
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
              <strong> Google Drive</strong> (an app-private folder), connect a local folder
              (shared via your own cloud drive), or use the in-memory provider to try it out.
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
                  <Button onClick={connectGoogle} disabled={!driveConfigured} data-testid="connect-google-drive">
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
              <Button variant="outline" onClick={connectMemory} data-testid="connect-memory">
                <ConnectIcon />
                In-memory (test)
              </Button>
            </div>
          </Surface>
        )}
      </section>

      {/* Sync */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Synchronise
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip
            content="Exchange changes both ways with the connected provider, merging newest-wins. Pauses automatically if local storage is critically full."
            triggerTabIndex={-1}
          >
            <span>
              <Button onClick={syncNow} disabled={!connected || busy} data-testid="sync-now">
                <SyncIcon />
                Sync now
              </Button>
            </span>
          </Tooltip>
          {/* Always-mounted polite region: the sync outcome appears in place after an
              explicit "Sync now", which a screen reader would otherwise miss (WCAG 4.1.3).
              The region must pre-exist for the later content change to be announced. */}
          <LiveRegion className="text-sm text-muted-foreground" data-testid="sync-result">
            {result && result.status !== 'HARD_STOP'
              ? `${result.status} · pulled ${result.pulled} · deleted ${result.deleted}` +
                (result.reparented > 0 ? ` · re-parented ${result.reparented}` : '') +
                (result.rejectedCycles > 0 ? ` · cycles blocked ${result.rejectedCycles}` : '')
              : null}
          </LiveRegion>
        </div>
      </section>

      {/* Backup & restore */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Backup &amp; restore
        </h2>
        <p className="text-sm text-muted-foreground">
          Save a complete backup — your inventory and records, full-resolution images, and
          settings — to a single file, then restore it later on this or another device. Choose
          exactly what to include.
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

      {/* Push to bridge — for users without folder sync, hand the dataset straight to the
          optional Home Assistant query bridge over HTTP (the bridge re-hydrates it). */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Push to bridge
        </h2>
        <p className="text-sm text-muted-foreground">
          Send your whole inventory to a Gubbins query bridge (e.g. for Home Assistant) over your
          local network, without needing a shared folder. The bridge must have pushes enabled
          (<code className="rounded bg-secondary/60 px-1">GUBBINS_BRIDGE_ALLOW_PUSH=on</code>). Your
          URL and token are stored only on this device.
        </p>
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
            hint="The bridge's `GUBBINS_BRIDGE_TOKEN`. Treated as a secret — stored only on this device and never synced."
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
          </div>
        </Surface>
      </section>
      </main>

      <BackupDialog
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        onRestored={(message) => {
          void client.invalidateQueries();
          setNotice(message);
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
