/**
 * Phase 63: aria-live status-message coverage for BackupDialog.
 *
 * Verifies WCAG 4.1.3 compliance for both the Create and Restore panels:
 * the always-mounted live regions exist before any operation and carry the
 * progress/outcome text after it completes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { BackupDialog } from './BackupDialog';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// createBackup and readBackup are the async IO boundaries — mock at the module
// level so no DB, OPFS, or Web Workers are touched.
const mockCreateBackup = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
const mockReadBackup = vi.hoisted(() => vi.fn<(f: File) => Promise<unknown>>());
const mockRestoreBackup = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

// `backupFilename` / `BACKUP_FILE_KIND` name the restore point's destination before the zip
// exists (issue #502); they are pure and carry no IO, so the mock keeps them faithful.
vi.mock('./build-backup', () => ({
  createBackup: mockCreateBackup,
  backupFilename: (prefix = 'gubbins-backup') => `${prefix}-20260630-120000.zip`,
  BACKUP_FILE_KIND: { description: 'Gubbins backup', mimeType: 'application/zip', extensions: ['.zip'] },
}));
vi.mock('./restore-backup', () => ({
  readBackup: mockReadBackup,
  restoreBackup: mockRestoreBackup,
  rememberRestoreNotice: vi.fn(),
}));

// estimateStorage is called inside RestorePanel after reading a backup.
vi.mock('@/features/storage/storage-api', () => ({
  estimateStorage: vi.fn().mockResolvedValue({ usage: 0, quota: 1_000_000, supported: true }),
}));

// ItemRepository.count() is called to build the Replace impact warning.
vi.mock('@/db/repositories', () => ({
  getItemRepository: () => ({ count: vi.fn().mockResolvedValue(5) }),
}));

// useFormatters is used by CreatePanel for size formatting.
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ bytes: (n: number) => `${n} B` }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal BackupResult that satisfies CreatePanel's result rendering. */
const BACKUP_RESULT = {
  filename: 'gubbins-backup-2026-06-30.zip',
  size: 1024,
  manifest: {
    appVersion: '0.1.0',
    createdAt: Date.now(),
    counts: { items: 42, images: 5 },
  },
  // The pre-Replace restore point provably reached the user (issue #502); the Create tab, which
  // is not about to delete anything, never reads this.
  secured: true,
};

/** A minimal ParsedBackup that satisfies RestorePanel's parsed rendering. */
const PARSED_BACKUP = {
  manifest: {
    appVersion: '0.1.0',
    createdAt: new Date('2026-06-01').getTime(),
  },
  snapshot: { tables: { items: Array(10).fill({ id: 'x' }) } },
  images: [],
  sqlite: null,
  settings: null,
};

function renderDialog(tab: 'create' | 'restore' = 'create') {
  render(<BackupDialog open onClose={() => {}} />);
  if (tab === 'restore') {
    fireEvent.click(screen.getByRole('tab', { name: /restore/i }));
  }
}

afterEach(cleanup);
beforeEach(() => {
  mockCreateBackup.mockReset();
  mockReadBackup.mockReset();
  mockRestoreBackup.mockReset();
});

// ---------------------------------------------------------------------------
// Create panel
// ---------------------------------------------------------------------------

describe('BackupDialog — Create panel aria-live coverage (Phase 63 / WCAG 4.1.3)', () => {
  it('mounts the polite live region BEFORE any backup is created', () => {
    renderDialog('create');
    const region = screen.getByTestId('create-backup-live-region');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
  });

  it('mounts the assertive (error) live region BEFORE any backup is created', () => {
    renderDialog('create');
    const region = screen.getByTestId('create-backup-error-live-region');
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('');
  });

  it('announces "Preparing backup…" while the operation is in progress', async () => {
    let resolve!: (r: typeof BACKUP_RESULT) => void;
    mockCreateBackup.mockReturnValue(new Promise<typeof BACKUP_RESULT>((r) => (resolve = r)));

    renderDialog('create');

    await act(async () => {
      fireEvent.click(screen.getByTestId('create-backup'));
    });

    expect(screen.getByTestId('create-backup-live-region').textContent).toBe('Preparing backup…');

    // Clean up — resolve so the component finishes.
    await act(async () => {
      resolve(BACKUP_RESULT);
    });
  });

  it('announces the filename and stats on successful backup', async () => {
    mockCreateBackup.mockResolvedValue(BACKUP_RESULT);

    renderDialog('create');

    await act(async () => {
      fireEvent.click(screen.getByTestId('create-backup'));
    });

    const region = screen.getByTestId('create-backup-live-region');
    expect(region.textContent).toContain('gubbins-backup-2026-06-30.zip');
    expect(region.textContent).toContain('42 items');
    // Error region stays empty on success.
    expect(screen.getByTestId('create-backup-error-live-region').textContent).toBe('');
  });

  it('announces the error message assertively on backup failure', async () => {
    mockCreateBackup.mockImplementation(async () => {
      throw new Error('Out of space.');
    });

    renderDialog('create');

    await act(async () => {
      fireEvent.click(screen.getByTestId('create-backup'));
    });

    const errorRegion = screen.getByTestId('create-backup-error-live-region');
    expect(errorRegion.getAttribute('aria-live')).toBe('assertive');
    expect(errorRegion.textContent).toContain('Out of space.');
    expect(screen.getByTestId('create-backup-live-region').textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Restore panel
// ---------------------------------------------------------------------------

describe('BackupDialog — Restore panel aria-live coverage (Phase 63 / WCAG 4.1.3)', () => {
  it('mounts the polite live region BEFORE a file is chosen', () => {
    renderDialog('restore');
    const region = screen.getByTestId('restore-live-region');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
  });

  it('mounts the assertive (error) live region BEFORE a file is chosen', () => {
    renderDialog('restore');
    const region = screen.getByTestId('restore-error-live-region');
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('');
  });

  it('announces "Reading {filename}…" while the backup file is being parsed', async () => {
    let resolve!: (p: typeof PARSED_BACKUP) => void;
    mockReadBackup.mockReturnValue(new Promise<typeof PARSED_BACKUP>((r) => (resolve = r)));

    renderDialog('restore');

    const file = new File(['{}'], 'my-backup.zip', { type: 'application/zip' });
    const input = screen.getByTestId('restore-backup-input');

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(screen.getByTestId('restore-live-region').textContent).toContain('Reading my-backup.zip…');

    // Resolve so the component finishes.
    await act(async () => {
      resolve(PARSED_BACKUP);
    });
  });

  it('announces the read error assertively when the file cannot be parsed', async () => {
    mockReadBackup.mockImplementation(async () => {
      throw new Error('Not a valid backup.');
    });

    renderDialog('restore');

    const file = new File(['bad'], 'broken.zip', { type: 'application/zip' });
    const input = screen.getByTestId('restore-backup-input');

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    const errorRegion = screen.getByTestId('restore-error-live-region');
    expect(errorRegion.getAttribute('aria-live')).toBe('assertive');
    expect(errorRegion.textContent).toContain('Not a valid backup.');
    expect(screen.getByTestId('restore-live-region').textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Per-group settings picker (issue #175)
// ---------------------------------------------------------------------------

/** A parsed backup carrying an appearance field and a saved-searches key, but no layout. */
const PARSED_WITH_SETTINGS = {
  ...PARSED_BACKUP,
  settings: {
    'gubbins:preferences': JSON.stringify({ state: { mode: 'dark' }, version: 3 }),
    'gubbins:saved-searches': '{"state":{"searches":[]}}',
  },
};

/** Choose a file in the Restore tab and let the (mocked) read settle. */
async function chooseBackupFile(parsed: unknown) {
  mockReadBackup.mockResolvedValue(parsed);
  const file = new File(['{}'], 'my-backup.zip', { type: 'application/zip' });
  await act(async () => {
    fireEvent.change(screen.getByTestId('restore-backup-input'), { target: { files: [file] } });
  });
}

describe('BackupDialog — choosing which settings travel (issue #175)', () => {
  it('offers every group under the settings toggle, and hides them when it is off', () => {
    renderDialog('create');
    expect(screen.getByTestId('backup-setting-group-appearance')).toBeTruthy();
    expect(screen.getByTestId('backup-setting-group-device')).toBeTruthy();

    fireEvent.click(screen.getByTestId('backup-toggle-settings'));
    expect(screen.queryByTestId('backup-setting-group-appearance')).toBeNull();
  });

  it('starts with everything but the device-specific group ticked', () => {
    renderDialog('create');
    expect((screen.getByTestId('backup-setting-group-appearance') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('backup-setting-group-device') as HTMLInputElement).checked).toBe(false);
  });

  it('passes the user’s group choice through to the backup', async () => {
    mockCreateBackup.mockResolvedValue(BACKUP_RESULT);
    renderDialog('create');

    fireEvent.click(screen.getByTestId('backup-setting-group-none'));
    fireEvent.click(screen.getByTestId('backup-setting-group-shortcuts'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('create-backup'));
    });

    const selection = mockCreateBackup.mock.calls[0]![0] as { settingGroups: Record<string, boolean> };
    expect(selection.settingGroups.shortcuts).toBe(true);
    expect(selection.settingGroups.appearance).toBe(false);
  });

  it('captures every group in the pre-Replace restore point, device settings included', async () => {
    // The restore point is the undo for a destructive Replace — the user never chose its shape,
    // so it must not inherit the create tab's "device settings off" default and lose them.
    mockCreateBackup.mockResolvedValue(BACKUP_RESULT);
    mockRestoreBackup.mockResolvedValue({ reloadRequired: false, imagesMissed: 0, message: 'done' });
    renderDialog('restore');
    await chooseBackupFile(PARSED_BACKUP);

    fireEvent.click(screen.getByTestId('restore-mode-replace'));
    fireEvent.click(screen.getByTestId('restore-backup'));
    fireEvent.change(screen.getByTestId('replace-confirm-input'), { target: { value: 'REPLACE' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-restore-backup'));
    });

    const selection = mockCreateBackup.mock.calls[0]![0] as { settingGroups: Record<string, boolean> };
    expect(Object.values(selection.settingGroups).every(Boolean)).toBe(true);
  });

  it('cancels the Replace when the restore point did not reach the user (issue #502)', async () => {
    // The bug this closes: the old code awaited `createBackup`, which only ever reported whether
    // the zip *built*. A browser that dropped the download looked exactly like one that saved it,
    // and the wipe went ahead on the strength of that.
    mockCreateBackup.mockResolvedValue({ ...BACKUP_RESULT, secured: false });
    mockRestoreBackup.mockResolvedValue({ reloadRequired: false, imagesMissed: 0, message: 'done' });
    renderDialog('restore');
    await chooseBackupFile(PARSED_BACKUP);

    fireEvent.click(screen.getByTestId('restore-mode-replace'));
    fireEvent.click(screen.getByTestId('restore-backup'));
    fireEvent.change(screen.getByTestId('replace-confirm-input'), { target: { value: 'REPLACE' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-restore-backup'));
    });

    expect(mockRestoreBackup).not.toHaveBeenCalled();
    expect(screen.getByTestId('restore-error-live-region').textContent).toMatch(/not confirmed as saved/i);
  });

  it('offers only the groups the chosen backup actually carries', async () => {
    renderDialog('restore');
    await chooseBackupFile(PARSED_WITH_SETTINGS);

    expect(screen.getByTestId('restore-setting-group-appearance')).toBeTruthy();
    expect(screen.getByTestId('restore-setting-group-savedSearches')).toBeTruthy();
    // The backup carries no dashboard layout, so ticking one would promise nothing.
    expect(screen.queryByTestId('restore-setting-group-dashboard')).toBeNull();
  });

  it('shows no picker at all for a backup with no settings', async () => {
    renderDialog('restore');
    await chooseBackupFile(PARSED_BACKUP);
    expect(screen.queryByTestId('restore-setting-group-appearance')).toBeNull();
  });

  it('leaves the device-specific group unticked when restoring, too', async () => {
    // Opt-in at both ends: a backup that happens to carry a bridge address must not silently
    // re-point a different device just because someone chose to include it when exporting.
    renderDialog('restore');
    await chooseBackupFile({
      ...PARSED_WITH_SETTINGS,
      settings: {
        'gubbins:preferences': JSON.stringify({
          state: { mode: 'dark', bridgeUrl: 'http://127.0.0.1:8787' },
          version: 3,
        }),
      },
    });

    expect((screen.getByTestId('restore-setting-group-appearance') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('restore-setting-group-device') as HTMLInputElement).checked).toBe(false);
  });

  it('applies only the groups left ticked when restoring', async () => {
    mockRestoreBackup.mockResolvedValue({ reloadRequired: false, imagesMissed: 0, message: 'done' });
    renderDialog('restore');
    await chooseBackupFile(PARSED_WITH_SETTINGS);

    fireEvent.click(screen.getByTestId('restore-setting-group-savedSearches')); // untick
    fireEvent.click(screen.getByTestId('restore-backup'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-restore-backup'));
    });

    const groups = mockRestoreBackup.mock.calls[0]![2] as Record<string, boolean>;
    expect(groups.appearance).toBe(true);
    expect(groups.savedSearches).toBe(false);
  });
});

/**
 * Issue #639: a restore whose images would not all write has still *happened* — the data has
 * committed and the old data is gone. Reporting it as a failure invited the user to try again or
 * to go looking for records that were no longer anywhere, so it is handed on as a partial
 * success in a warning voice instead.
 */
describe('BackupDialog — a restore that could not save every image (issue #639)', () => {
  it('hands a partial restore on as a warning-toned success, not an error', async () => {
    const onRestored = vi.fn();
    mockRestoreBackup.mockResolvedValue({
      reloadRequired: false,
      imagesMissed: 3,
      message: 'Merged in backup — 10 items, 12 images. 3 images could not be saved to this device.',
    });
    render(<BackupDialog open onClose={() => {}} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('tab', { name: /restore/i }));
    await chooseBackupFile(PARSED_BACKUP);

    fireEvent.click(screen.getByTestId('restore-backup'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-restore-backup'));
    });

    expect(onRestored).toHaveBeenCalledWith({
      message: 'Merged in backup — 10 items, 12 images. 3 images could not be saved to this device.',
      tone: 'warning',
    });
    expect(screen.getByTestId('restore-error-live-region').textContent).toBe('');
  });

  it('keeps the ordinary voice when nothing was missed', async () => {
    const onRestored = vi.fn();
    mockRestoreBackup.mockResolvedValue({
      reloadRequired: false,
      imagesMissed: 0,
      message: 'Merged in backup — 10 items.',
    });
    render(<BackupDialog open onClose={() => {}} onRestored={onRestored} />);
    fireEvent.click(screen.getByRole('tab', { name: /restore/i }));
    await chooseBackupFile(PARSED_BACKUP);

    fireEvent.click(screen.getByTestId('restore-backup'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-restore-backup'));
    });

    expect(onRestored).toHaveBeenCalledWith({ message: 'Merged in backup — 10 items.', tone: 'info' });
  });
});
