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

const DEFAULT_FILE_NAME = 'gubbins-sync.json';

// Minimal typings — the File System Access API is not fully in lib.dom.
interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface FsDirectoryHandle {
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
 * cancels the picker.
 */
export async function connectFileSystemProvider(): Promise<FileSystemCloudProvider | null> {
  if (!hasFileSystemAccess() || typeof globalThis === 'undefined') return null;
  const picker = (globalThis as { showDirectoryPicker?: (opts?: unknown) => Promise<FsDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof picker !== 'function') return null;
  try {
    const dir = await picker({ mode: 'readwrite' });
    return new FileSystemCloudProvider(dir);
  } catch {
    // User cancelled the picker, or permission was denied.
    return null;
  }
}
