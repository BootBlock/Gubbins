/**
 * Restoring is not all-or-nothing past the database commit (issue #639).
 *
 * Every restore writes the data first and re-hydrates the full-resolution images afterwards. A
 * failure in that second step used to unwind the whole call, so the user was told "the restore
 * failed" over a device whose old data was already gone and whose new data was already there —
 * and in the exact-copy path the worker had been disposed with no reload scheduled, leaving the
 * app unable to answer a query. These assert the other shape: the images are counted, the
 * restore is reported as the partial success it is, and the caller still reloads or refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncSnapshot } from '@/features/sync/snapshot';
import type { ParsedBackup } from './backup-format';

const writeImageFiles = vi.hoisted(() => vi.fn());
const overwriteDatabaseFile = vi.hoisted(() => vi.fn());
const restoreSnapshot = vi.hoisted(() => vi.fn());
const applySettings = vi.hoisted(() => vi.fn(() => 0));
const transaction = vi.hoisted(() => vi.fn());

vi.mock('@/features/images/opfs-images', () => ({ writeImageFiles }));
vi.mock('@/db/client', () => ({ getDatabaseDriver: () => ({ transaction }) }));
vi.mock('@/features/sync/snapshot', () => ({
  restoreSnapshot,
  buildSchemaDictionary: vi.fn(async () => ({})),
  buildCloneStatements: vi.fn(() => []),
  withCaptureDisabled: (statements: unknown) => statements,
  SYNC_TABLES: [],
}));
vi.mock('@/db/repositories', () => ({
  ITEM_HISTORY_TABLE: 'item_history',
  STOCK_DELTAS_TABLE: 'stock_deltas',
}));
vi.mock('@/app/error/safe-mode-actions', () => ({
  overwriteDatabaseFile,
  // The real class re-declared: `restoreReplace` narrows on `instanceof`, so the constructor the
  // test throws has to be the one the module under test imports — which the mock guarantees.
  StaleJournalError: class StaleJournalError extends Error {
    readonly sidecar: string;
    constructor(sidecar: string) {
      super('Your data was restored, but a leftover database file could not be removed.');
      this.name = 'StaleJournalError';
      this.sidecar = sidecar;
    }
  },
}));
vi.mock('./backup-settings', () => ({ applySettings }));

const { StaleJournalError } = await import('@/app/error/safe-mode-actions');
const { consumeRestoreNotice, rememberRestoreNotice, restoreBackup } = await import('./restore-backup');

/** Bytes that begin with the SQLite 3 magic header — enough for the paths exercised here. */
const SQLITE_BYTES = new TextEncoder().encode('SQLite format 3\0payload');

/** A parsed backup carrying `images` full-resolution files, optionally with an exact copy. */
function parsedBackup(images: number, sqlite: Uint8Array | null = null): ParsedBackup {
  return {
    manifest: null,
    manifestUnreadable: false,
    snapshot: { tables: { items: [{ id: 'item-a' }, { id: 'item-b' }] } } as unknown as SyncSnapshot,
    sqlite,
    images: Array.from({ length: images }, (_, i) => ({
      name: `image-${i}.webp`,
      bytes: new Uint8Array([i]),
    })),
    settings: null,
  };
}

/** What {@link writeImageFiles} reports when `missed` files would not write. */
function imageReport(missed: number) {
  return {
    failed: Array.from({ length: missed }, (_, i) => `image-${i}.webp`),
    failure: missed > 0 ? new Error('QuotaExceededError') : undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  applySettings.mockReturnValue(0);
  writeImageFiles.mockResolvedValue(imageReport(0));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreBackup — images that will not write (issue #639)', () => {
  it('reports a merge that landed minus some images, rather than throwing', async () => {
    writeImageFiles.mockResolvedValue(imageReport(3));

    const outcome = await restoreBackup(parsedBackup(4), 'merge');

    expect(restoreSnapshot).toHaveBeenCalledOnce(); // the data itself went in
    expect(outcome.imagesMissed).toBe(3);
    expect(outcome.message).toContain('3 images could not be saved');
    expect(outcome.message).toContain('everything else was restored');
  });

  it('still requires the reload after an exact-copy replace, so the disposed worker comes back', async () => {
    writeImageFiles.mockResolvedValue(imageReport(1));

    const outcome = await restoreBackup(parsedBackup(2, SQLITE_BYTES), 'replace');

    expect(overwriteDatabaseFile).toHaveBeenCalledOnce();
    // The whole hazard in one assertion: the worker is gone, so a caller that treated this as a
    // failure would leave the app with nothing to talk to and no reason to reload.
    expect(outcome.reloadRequired).toBe(true);
    expect(outcome.imagesMissed).toBe(1);
    expect(outcome.message).toContain('1 image could not be saved');
  });

  it('reports the shortfall from a wipe-and-clone replace too, without a reload', async () => {
    writeImageFiles.mockResolvedValue(imageReport(2));

    const outcome = await restoreBackup(parsedBackup(2), 'replace');

    expect(transaction).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ reloadRequired: false, imagesMissed: 2 });
  });

  it('says nothing about images when they all land', async () => {
    writeImageFiles.mockResolvedValue(imageReport(0));

    const outcome = await restoreBackup(parsedBackup(3), 'merge');

    expect(outcome.imagesMissed).toBe(0);
    expect(outcome.message).toBe('Merged in backup — 2 items, 3 images.');
  });

  it('skips the write entirely for a backup that carries no images', async () => {
    const outcome = await restoreBackup(parsedBackup(0), 'merge');

    expect(writeImageFiles).not.toHaveBeenCalled();
    expect(outcome.imagesMissed).toBe(0);
  });

  it('still surfaces a stale journal, which must stop the reload rather than defer it (#203)', async () => {
    overwriteDatabaseFile.mockRejectedValueOnce(new StaleJournalError('gubbins.sqlite3-wal'));
    writeImageFiles.mockResolvedValue(imageReport(1));

    await expect(restoreBackup(parsedBackup(2, SQLITE_BYTES), 'replace')).rejects.toBeInstanceOf(
      StaleJournalError,
    );

    // The images are still written first: the restore landed, so both halves belong beside it.
    expect(writeImageFiles).toHaveBeenCalledOnce();
  });
});

describe('the post-reload notice', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('carries its tone across the reload, so a partial success is not said in the success voice', () => {
    rememberRestoreNotice({ message: 'Replaced from backup — 2 items.', tone: 'warning' });

    expect(consumeRestoreNotice()).toEqual({
      message: 'Replaced from backup — 2 items.',
      tone: 'warning',
    });
  });

  it('is one-shot — a second read after the same restore finds nothing', () => {
    rememberRestoreNotice({ message: 'Merged in backup — 2 items.', tone: 'info' });

    expect(consumeRestoreNotice()).not.toBeNull();
    expect(consumeRestoreNotice()).toBeNull();
  });

  it('discards a stored value it cannot read, rather than showing it every mount', () => {
    sessionStorage.setItem('gubbins:backup-restored', 'not json');

    expect(consumeRestoreNotice()).toBeNull();
    expect(sessionStorage.getItem('gubbins:backup-restored')).toBeNull();
  });
});
