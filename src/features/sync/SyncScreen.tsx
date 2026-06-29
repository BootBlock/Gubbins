import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, FormField, Input, LiveRegion, Surface, Tooltip, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  BrandIcon,
  CloudIcon,
  CloudUploadIcon,
  ConnectIcon,
  DisconnectIcon,
  DownloadIcon,
  FolderSyncIcon,
  PackageIcon,
  RestoreIcon,
  SyncIcon,
} from '@/components/icons';
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import { useFormatters } from '@/lib/useFormatters';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { buildBackupJson, restoreFromBackupJson } from './backup';
import { buildPushSnapshotJson, pushSnapshotToBridge } from './push-to-bridge';
import { MemoryCloudProvider } from './providers/memory-provider';
import {
  connectFileSystemProvider,
  forgetFileSystemProvider,
  reconnectFileSystemProvider,
} from './providers/file-system-provider';
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
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [reconnectable, setReconnectable] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fsSupported = hasFileSystemAccess();

  // Phase 14: resume the previously-chosen sync folder across sessions. On mount we only
  // reconnect when the OS permission still stands; a handle needing a fresh grant surfaces
  // a "Reconnect folder" button (the re-grant needs a user gesture).
  useEffect(() => {
    if (getActiveProvider() !== null || auth.providerId !== 'file-system') return;
    let cancelled = false;
    void reconnectFileSystemProvider(false).then((res) => {
      if (cancelled) return;
      if (res.provider) {
        connect({ id: res.provider.id, label: res.provider.label }, res.provider);
      } else if (res.needsGesture) {
        setReconnectable(true);
      }
    });
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

  function disconnect() {
    setActiveProvider(null);
    auth.disconnect();
    setConnected(false);
    setReconnectable(false);
    setResult(null);
    void forgetFileSystemProvider(); // drop the persisted folder handle (Phase 14)
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
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  }

  async function downloadBackup() {
    setBusy(true);
    setError(null);
    try {
      const json = await buildBackupJson(getSyncDriver());
      const blob = new Blob([json], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `gubbins-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(href);
      setNotice('Backup downloaded.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      setPendingRestore(await file.text());
      setError(null);
    } catch {
      setError('That file could not be read.');
    }
  }

  async function confirmRestore() {
    if (pendingRestore === null) return;
    setBusy(true);
    setError(null);
    try {
      await restoreFromBackupJson(getSyncDriver(), pendingRestore);
      await client.invalidateQueries();
      setNotice('Backup imported.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setPendingRestore(null);
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
  const configuredButOffline = !connected && auth.providerId !== null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary [&_svg]:size-5">
            <BrandIcon />
          </span>
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
          <CloudIcon /> Cloud Sync &amp; backups
        </h1>
        <Link
          to="/inventory"
          className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <PackageIcon />
          Inventory
        </Link>
      </header>

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
              Choose where to synchronise. Gubbins is provider-agnostic — connect a local
              folder (shared via your own cloud drive) or the in-memory provider for trying it out.
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
            ) : configuredButOffline ? (
              <Banner tone="warning">
                Previously connected to {auth.providerLabel}. Reconnect to resume syncing.
              </Banner>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button onClick={connectMemory} data-testid="connect-memory">
                <ConnectIcon />
                In-memory (test)
              </Button>
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
          Backups are a versioned JSON file mirroring the sync payload, so they restore cleanly
          across devices and schema versions.
        </p>
        <div className="flex flex-wrap gap-2">
          <Tooltip
            content="Save a versioned JSON snapshot of everything to your downloads — restorable on any device, across schema versions."
            triggerTabIndex={-1}
          >
            <span>
              <Button variant="outline" onClick={downloadBackup} disabled={busy} data-testid="download-backup">
                <DownloadIcon />
                Download backup
              </Button>
            </span>
          </Tooltip>
          <Tooltip
            content="Load a backup JSON file. It **adds and updates** inventory (re-creating anything deleted since); items you have added are kept."
            triggerTabIndex={-1}
          >
            <span>
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
                <RestoreIcon />
                Restore from file…
              </Button>
            </span>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            data-testid="restore-input"
            onChange={onFileChosen}
          />
        </div>
        {pendingRestore !== null ? (
          <Banner tone="warning">
            <div className="space-y-2">
              <p>
                Importing will <strong>add and update inventory from the backup</strong> (re-creating
                anything deleted since). Existing items you have added are kept.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={confirmRestore} data-testid="confirm-restore">
                  Import backup
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPendingRestore(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Banner>
        ) : null}
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
    </div>
  );
}
