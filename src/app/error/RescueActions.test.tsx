/**
 * RescueActions — a failed rescue must *say so* (issue #309).
 *
 * Safe Mode is reached only after a crash, so a button that spins, stops and changes nothing
 * is the worst possible outcome: it reads as "the gentle option was tried and did not help",
 * which is exactly the belief that pushes someone on to the irreversible hard reset.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RescueActions } from './RescueActions';

vi.mock('./safe-mode-actions', () => ({
  downloadRawSqlite: vi.fn(),
  downloadJsonDump: vi.fn(),
  hardResetLocalData: vi.fn(),
  resetServiceWorkerOnly: vi.fn(),
  restoreRawSqlite: vi.fn(),
  // The real class, re-declared: the component narrows on `instanceof`, so the constructor the
  // test throws and the one it imports have to be the same object — which they are via the mock.
  DamagedDatabaseError: class DamagedDatabaseError extends Error {
    problems: readonly string[];
    constructor(problems: readonly string[]) {
      super('That database file is damaged.');
      this.name = 'DamagedDatabaseError';
      this.problems = problems;
    }
  },
}));

vi.mock('@/features/archive/restore-archive', () => ({ restoreArchive: vi.fn() }));

vi.mock('@/features/backup/build-backup', () => ({ createRescueBackup: vi.fn() }));

vi.mock('@/features/errors', () => ({
  useErrorMessage: () => (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

const actions = await import('./safe-mode-actions');
const { createRescueBackup } = await import('@/features/backup/build-backup');

/** A successful rescue backup, with whatever counts / omissions a test needs. */
function backupResult(overrides: { items?: number; images?: number; skipped?: readonly string[] } = {}) {
  return {
    filename: 'gubbins-rescue-backup-20260101-000000.zip',
    size: 1024,
    skipped: overrides.skipped ?? [],
    manifest: { counts: { items: overrides.items ?? 3, images: overrides.images ?? 0 } },
  } as unknown as Awaited<ReturnType<typeof createRescueBackup>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('RescueActions', () => {
  it('surfaces a failed download instead of only logging it', async () => {
    vi.mocked(actions.downloadRawSqlite).mockRejectedValue(new Error('Export failed: disk full.'));
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /download raw \.sqlite/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Export failed: disk full.');
  });

  it('falls back to the action’s own copy when the thrown value says nothing human', async () => {
    vi.mocked(actions.downloadJsonDump).mockRejectedValue('nope');
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /export data \(json\)/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not export your data.');
  });

  it('reports a hard reset that could not complete', async () => {
    vi.mocked(actions.hardResetLocalData).mockRejectedValue(new Error('OPFS locked.'));
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /hard reset/i }));
    await user.click(screen.getByRole('button', { name: /confirm — purge/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('OPFS locked.');
  });

  it('clears a previous failure when another action is started', async () => {
    vi.mocked(actions.downloadRawSqlite).mockRejectedValue(new Error('First failure.'));
    vi.mocked(actions.downloadJsonDump).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /download raw \.sqlite/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('First failure.');

    await user.click(screen.getByRole('button', { name: /export data \(json\)/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('places the failure above the hard reset, not below it', async () => {
    vi.mocked(actions.downloadRawSqlite).mockRejectedValue(new Error('Nope.'));
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /download raw \.sqlite/i }));
    const alert = await screen.findByRole('alert');
    const reset = screen.getByRole('button', { name: /hard reset/i });

    // The user must read why the gentle rescue failed *before* reaching the irreversible one.
    expect(alert.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the data-preserving reinstall above the hard reset (issue #276)', async () => {
    render(<RescueActions />);

    const reinstall = screen.getByRole('button', { name: /reinstall app files/i });
    const reset = screen.getByRole('button', { name: /hard reset/i });

    // A bad *build* must be fixable without paying for it with the user's inventory, and the
    // gentle option has to come first or the purge reads as the only worker reset on offer.
    expect(reinstall.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reinstalls app files without confirmation — nothing is destroyed', async () => {
    vi.mocked(actions.resetServiceWorkerOnly).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /reinstall app files/i }));

    await waitFor(() => expect(actions.resetServiceWorkerOnly).toHaveBeenCalledOnce());
    expect(actions.hardResetLocalData).not.toHaveBeenCalled();
  });

  it('surfaces a failed reinstall rather than silently doing nothing', async () => {
    vi.mocked(actions.resetServiceWorkerOnly).mockRejectedValue(new Error('Cache locked.'));
    const user = userEvent.setup();
    render(<RescueActions />);

    await user.click(screen.getByRole('button', { name: /reinstall app files/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cache locked.');
  });

  describe('restoring a damaged database (issue #198)', () => {
    /** Choose a `.sqlite` file and reach the confirmation panel. */
    async function chooseSqliteFile(user: ReturnType<typeof userEvent.setup>) {
      const file = new File(['irrelevant'], 'rescue.sqlite', { type: 'application/x-sqlite3' });
      await user.upload(screen.getByTestId('restore-sqlite-input'), file);
      return file;
    }

    it('promises a restore point before the user confirms an overwrite', async () => {
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      expect(screen.getByText(/copy of your current database is downloaded first/i)).toBeInTheDocument();
    });

    it('shows what is wrong instead of silently overwriting good data', async () => {
      vi.mocked(actions.restoreRawSqlite).mockRejectedValue(
        new actions.DamagedDatabaseError(['The file looks truncated.']),
      );
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The file looks truncated.');
      expect(alert).toHaveTextContent(/nothing has been changed/i);
    });

    it('offers an explicit override, since a damaged copy may be all the user has left', async () => {
      vi.mocked(actions.restoreRawSqlite).mockRejectedValue(
        new actions.DamagedDatabaseError(['The file looks truncated.']),
      );
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));
      await screen.findByRole('alert');

      // The same button, now re-labelled — and only this second press forces the restore.
      expect(actions.restoreRawSqlite).toHaveBeenLastCalledWith(expect.any(File), { force: false });
      await user.click(screen.getByRole('button', { name: /restore anyway/i }));
      expect(actions.restoreRawSqlite).toHaveBeenLastCalledWith(expect.any(File), { force: true });
    });

    it('drops the damage report when a different file is chosen', async () => {
      vi.mocked(actions.restoreRawSqlite).mockRejectedValue(
        new actions.DamagedDatabaseError(['The file looks truncated.']),
      );
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);
      await user.click(screen.getByTestId('confirm-archive-restore'));
      await screen.findByRole('alert');

      await chooseSqliteFile(user);

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: /confirm — restore/i })).toBeInTheDocument();
    });
  });

  /**
   * Issue #197: the screen's own advice ends in a purge, so it has to hand out something the
   * app can read back. Before this, both downloads on offer were dead ends — a `.sqlite` the
   * restore guard refuses after a schema change, and a JSON dump nothing imports.
   */
  describe('the restorable backup', () => {
    it('offers a backup and says where it can be restored from', async () => {
      render(<RescueActions />);

      expect(screen.getByRole('button', { name: /back up everything/i })).toBeInTheDocument();
      expect(screen.getByText(/Backup & Restore/i)).toBeInTheDocument();
    });

    it('reports what the backup actually captured', async () => {
      vi.mocked(createRescueBackup).mockResolvedValue(backupResult({ items: 42, images: 7 }));
      const user = userEvent.setup();
      render(<RescueActions />);

      await user.click(screen.getByRole('button', { name: /back up everything/i }));

      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('42 items');
      expect(status).toHaveTextContent('7 images');
    });

    it('names anything the failed database would not give up, rather than claiming success', async () => {
      vi.mocked(createRescueBackup).mockResolvedValue(
        backupResult({ skipped: ['categories', 'tombstones'] }),
      );
      const user = userEvent.setup();
      render(<RescueActions />);

      await user.click(screen.getByRole('button', { name: /back up everything/i }));

      // A partial backup the user believes is complete is how data is lost at the next step.
      expect(await screen.findByRole('status')).toHaveTextContent('categories, tombstones');
    });

    it('surfaces a backup that could not be built at all', async () => {
      vi.mocked(createRescueBackup).mockRejectedValue(new Error('Database unreadable.'));
      const user = userEvent.setup();
      render(<RescueActions />);

      await user.click(screen.getByRole('button', { name: /back up everything/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Database unreadable.');
    });
  });

  it('leaves the button usable after a failure so the user can retry', async () => {
    vi.mocked(actions.downloadRawSqlite).mockRejectedValue(new Error('Transient.'));
    const user = userEvent.setup();
    render(<RescueActions />);

    const button = screen.getByRole('button', { name: /download raw \.sqlite/i });
    await user.click(button);
    await screen.findByRole('alert');

    expect(button).toBeEnabled();
  });
});
