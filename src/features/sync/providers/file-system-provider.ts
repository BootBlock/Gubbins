/**
 * File System Access CloudProvider adapter (spec §2 Data Persistence, §1.2, Phase 7).
 *
 * Treats a user-chosen local directory as the "remote": the merged snapshot is
 * written there as a single versioned JSON file (mirroring the §2 backup payload),
 * so two devices pointed at the same synced folder (a cloud-drive mount, a USB key)
 * reconcile through it with no provider SDK. Browser-only and feature-detected — the
 * directory handle can only be obtained from a user gesture, so {@link connectFileSystemProvider}
 * must be called from a click handler.
 */
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import type { CloudProvider } from '../provider';
import { parseBackupJson, snapshotToBackupJson } from '../backup';
import type { SyncSnapshot } from '../types';
import {
  forgetSyncDirectory,
  handlePermission,
  loadSyncDirectory,
  persistSyncDirectory,
  reconnectAction,
  type PersistableDirectoryHandle,
} from './fs-handle-store';

const DEFAULT_FILE_NAME = 'gubbins-sync.json';

// Minimal typings — the File System Access API is not fully in lib.dom.
interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface FsDirectoryHandle extends PersistableDirectoryHandle {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
}

export class FileSystemCloudProvider implements CloudProvider {
  readonly id = 'file-system';
  readonly label: string;

  constructor(
    private readonly dir: FsDirectoryHandle,
    private readonly fileName = DEFAULT_FILE_NAME,
  ) {
    this.label = `Local folder · ${dir.name}`;
  }

  /** A local folder has no authoritative clock, so trust the local one (offset 0). */
  async getServerTime(): Promise<number | null> {
    return null;
  }

  async fetchSnapshot(): Promise<SyncSnapshot | null> {
    try {
      const handle = await this.dir.getFileHandle(this.fileName);
      const text = await (await handle.getFile()).text();
      if (text.trim().length === 0) return null;
      return parseBackupJson(text);
    } catch {
      // No file yet (or unreadable) → an empty remote.
      return null;
    }
  }

  async pushSnapshot(snapshot: SyncSnapshot): Promise<void> {
    const handle = await this.dir.getFileHandle(this.fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(snapshotToBackupJson(snapshot));
    await writable.close();
  }
}

/**
 * Prompt for a sync directory and connect a {@link FileSystemCloudProvider}. Must be
 * invoked from a user gesture. Returns null when the API is unsupported or the user
 * cancels the picker. The chosen handle is persisted (Phase 14) so a later session can
 * resume through it without re-prompting.
 */
export async function connectFileSystemProvider(): Promise<FileSystemCloudProvider | null> {
  if (!hasFileSystemAccess() || typeof globalThis === 'undefined') return null;
  const picker = (globalThis as { showDirectoryPicker?: (opts?: unknown) => Promise<FsDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  try {
    const dir = await picker({ mode: 'readwrite' });
    await persistSyncDirectory(dir);
    return new FileSystemCloudProvider(dir);
  } catch {
    // User cancelled the picker, or permission was denied.
    return null;
  }
}

export interface ReconnectResult {
  /** The reconnected provider, or null when none is available (or a gesture is needed). */
  readonly provider: FileSystemCloudProvider | null;
  /**
   * True when a persisted handle exists but needs a fresh user gesture to re-grant
   * `readwrite` permission — the UI should surface a "Reconnect folder" button that calls
   * this again with `allowPrompt`.
   */
  readonly needsGesture: boolean;
}

const NO_RECONNECT: ReconnectResult = { provider: null, needsGesture: false };

/**
 * Attempt to resume the previously-chosen sync folder (Phase 14). With `allowPrompt`
 * false (e.g. on mount) it only reconnects when the permission is still granted; a handle
 * that needs re-granting returns `needsGesture` so the UI can offer a click. With
 * `allowPrompt` true (inside a user gesture) it requests permission. A handle whose grant
 * is irrecoverable (`denied`/unsupported) is forgotten so it does not nag every load.
 */
export async function reconnectFileSystemProvider(allowPrompt = false): Promise<ReconnectResult> {
  if (!hasFileSystemAccess()) return NO_RECONNECT;
  const handle = (await loadSyncDirectory()) as FsDirectoryHandle | null;
  if (!handle) return NO_RECONNECT;

  const action = reconnectAction(await handlePermission(handle));
  if (action === 'connect') return { provider: new FileSystemCloudProvider(handle), needsGesture: false };
  if (action === 'forget') {
    await forgetSyncDirectory();
    return NO_RECONNECT;
  }

  // action === 'needs-gesture'
  if (!allowPrompt || typeof handle.requestPermission !== 'function') {
    return { provider: null, needsGesture: true };
  }
  try {
    const granted = await handle.requestPermission({ mode: 'readwrite' });
    if (granted === 'granted') {
      return { provider: new FileSystemCloudProvider(handle), needsGesture: false };
    }
  } catch {
    // Fall through — the user denied or the prompt failed.
  }
  return { provider: null, needsGesture: true };
}

/** Forget the persisted sync directory (called on explicit disconnect). */
export async function forgetFileSystemProvider(): Promise<void> {
  await forgetSyncDirectory();
}
