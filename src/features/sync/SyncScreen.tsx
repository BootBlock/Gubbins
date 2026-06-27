import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Surface, Tooltip } from '@/components/foundry';
import {
  BrandIcon,
  CloudIcon,
  ConnectIcon,
  DisconnectIcon,
  DownloadIcon,
  FolderSyncIcon,
  PackageIcon,
  RestoreIcon,
  SyncIcon,
} from '@/components/icons';
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import { useAuthStore } from '@/state/stores/useAuthStore';
import { buildBackupJson, restoreFromBackupJson } from './backup';
import { MemoryCloudProvider } from './providers/memory-provider';
import { connectFileSystemProvider } from './providers/file-system-provider';
import { getActiveProvider, getSyncDriver, setActiveProvider } from './runtime';
import { runSync, type SyncResult } from './sync-engine';

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
  const [connected, setConnected] = useState(getActiveProvider() !== null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fsSupported = hasFileSystemAccess();

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
    setResult(null);
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
      const outcome = await runSync(getSyncDriver(), provider);
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

      {error ? <Banner tone="danger" data-testid="sync-error">{error}</Banner> : null}
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
                  ? `Last synced ${new Date(auth.lastSyncedAt).toLocaleString('en-GB')}`
                  : 'Not yet synced.'}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={disconnect}>
              <DisconnectIcon />
              Disconnect
            </Button>
          </Surface>
        ) : (
          <Surface className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              Choose where to synchronise. Gubbins is provider-agnostic — connect a local
              folder (shared via your own cloud drive) or the in-memory provider for trying it out.
            </p>
            {configuredButOffline ? (
              <Banner tone="warning">
                Previously connected to {auth.providerLabel}, but the connection does not survive a
                reload — reconnect to resume syncing.
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
          <Button onClick={syncNow} disabled={!connected || busy} data-testid="sync-now">
            <SyncIcon />
            Sync now
          </Button>
          {result && result.status !== 'HARD_STOP' ? (
            <span className="text-sm text-muted-foreground" data-testid="sync-result">
              {result.status} · pulled {result.pulled} · deleted {result.deleted}
              {result.reparented > 0 ? ` · re-parented ${result.reparented}` : ''}
              {result.rejectedCycles > 0 ? ` · cycles blocked ${result.rejectedCycles}` : ''}
            </span>
          ) : null}
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
          <Button variant="outline" onClick={downloadBackup} disabled={busy} data-testid="download-backup">
            <DownloadIcon />
            Download backup
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            <RestoreIcon />
            Restore from file…
          </Button>
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
    </div>
  );
}
