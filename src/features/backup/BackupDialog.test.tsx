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
const mockCreateBackup = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockReadBackup   = vi.hoisted(() => vi.fn<(f: File) => Promise<unknown>>());
const mockRestoreBackup = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

vi.mock('./build-backup', () => ({ createBackup: mockCreateBackup }));
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
    appVersion: '0.9.0',
    createdAt: Date.now(),
    counts: { items: 42, images: 5 },
  },
};

/** A minimal ParsedBackup that satisfies RestorePanel's parsed rendering. */
const PARSED_BACKUP = {
  manifest: {
    appVersion: '0.9.0',
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
    await act(async () => { resolve(BACKUP_RESULT); });
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
    mockCreateBackup.mockImplementation(async () => { throw new Error('Out of space.'); });

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
    await act(async () => { resolve(PARSED_BACKUP); });
  });

  it('announces the read error assertively when the file cannot be parsed', async () => {
    mockReadBackup.mockImplementation(async () => { throw new Error('Not a valid backup.'); });

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
