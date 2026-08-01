/**
 * RescueActions — a failed rescue must *say so* (issue #309).
 *
 * Safe Mode is reached only after a crash, so a button that spins, stops and changes nothing
 * is the worst possible outcome: it reads as "the gentle option was tried and did not help",
 * which is exactly the belief that pushes someone on to the irreversible hard reset.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  IncompatibleDatabaseError: class IncompatibleDatabaseError extends Error {
    constructor() {
      super('That database was made by a different version of Gubbins.');
      this.name = 'IncompatibleDatabaseError';
    }
  },
  RestorePointNotSavedError: class RestorePointNotSavedError extends Error {
    constructor() {
      super('The copy of your current database was not confirmed as saved.');
      this.name = 'RestorePointNotSavedError';
    }
  },
  // Where the restore point goes (issue #502) — pure naming, so the mock keeps it faithful.
  restorePointFilename: () => 'gubbins-restore-point-20260101-000000.sqlite',
  SQLITE_FILE_KIND: {
    description: 'SQLite database',
    mimeType: 'application/x-sqlite3',
    extensions: ['.sqlite'],
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
const { restoreArchive } = await import('@/features/archive/restore-archive');

/**
 * The restore point's destination, reserved in the click and threaded into the restore
 * (issue #502). Asserted rather than waved through with `objectContaining`, because a restore
 * that quietly lost it would go back to overwriting on the strength of an unobserved download.
 * jsdom has no File System Access API, so this is always the anchor route.
 */
const RESTORE_POINT_SAVE = {
  saver: {
    filename: 'gubbins-restore-point-20260101-000000.sqlite',
    save: expect.any(Function),
  },
  confirmUnverified: expect.any(Function),
};

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

      // "saved", not "downloaded": the restore now waits on the copy actually landing (#502).
      expect(screen.getByText(/copy of your current database is saved first/i)).toBeInTheDocument();
    });

    it('keeps the chosen file when the restore point was not confirmed as saved (issue #502)', async () => {
      // Nothing was written, and another go at saving the copy is the obvious next move — so
      // this must not throw the user back to the file picker as an ordinary failure does.
      vi.mocked(actions.restoreRawSqlite).mockRejectedValue(new actions.RestorePointNotSavedError());
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not confirmed as saved/i);
      expect(screen.getByTestId('confirm-archive-restore')).toBeInTheDocument();
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
      expect(actions.restoreRawSqlite).toHaveBeenLastCalledWith(expect.any(File), {
        force: false,
        save: RESTORE_POINT_SAVE,
      });
      await user.click(screen.getByRole('button', { name: /restore anyway/i }));
      expect(actions.restoreRawSqlite).toHaveBeenLastCalledWith(expect.any(File), {
        force: true,
        save: RESTORE_POINT_SAVE,
      });
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

  describe('restoring a database from another version (issue #501)', () => {
    async function chooseSqliteFile(user: ReturnType<typeof userEvent.setup>) {
      const file = new File(['irrelevant'], 'rescue.sqlite', { type: 'application/x-sqlite3' });
      await user.upload(screen.getByTestId('restore-sqlite-input'), file);
      return file;
    }

    beforeEach(() => {
      vi.mocked(actions.restoreRawSqlite).mockRejectedValue(new actions.IncompatibleDatabaseError());
    });

    it('explains that the file is intact but unopenable, and points at what does work', async () => {
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/made by a different version of Gubbins/i);
      expect(alert).toHaveTextContent(/nothing has been changed/i);
      // Saying only "no" on a crash screen is what sends a user to the purge; the way across is
      // the `.zip` restored with Merge.
      expect(alert).toHaveTextContent(/Merge/);
    });

    it('does not claim the file is damaged — it is not', async () => {
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));
      const alert = await screen.findByRole('alert');

      expect(alert).not.toHaveTextContent(/damaged/i);
    });

    it('warns that the override risks a Gubbins that will not start, then forces it', async () => {
      const user = userEvent.setup();
      render(<RescueActions />);
      await chooseSqliteFile(user);

      await user.click(screen.getByTestId('confirm-archive-restore'));
      await screen.findByRole('alert');

      // The button has to name *this* risk, not the damage report's "may lose records".
      const override = screen.getByRole('button', { name: /restore anyway — Gubbins may not start/i });
      await user.click(override);
      expect(actions.restoreRawSqlite).toHaveBeenLastCalledWith(expect.any(File), {
        force: true,
        save: RESTORE_POINT_SAVE,
      });
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
      // The *where* is the point: naming the feature alone once let the advice drift to a
      // "Settings → Backup & Restore" that no longer existed, so assert the screen too.
      expect(screen.getByText(/Sync → Backup & restore/i)).toBeInTheDocument();
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

  /**
   * Issue #639: the archive's images are written after its database has already replaced the
   * live one, so a write that fails there cannot be unwound. Reporting it as "restore failed"
   * pointed the user back at data that no longer existed, and the reload that the disposed
   * worker made mandatory never ran — leaving the app unable to answer a single query.
   */
  describe('an archive restore that could not save every image (issue #639)', () => {
    async function restoreArchiveFile(user: ReturnType<typeof userEvent.setup>) {
      const file = new File(['irrelevant'], 'gubbins-archive.zip', { type: 'application/zip' });
      await user.upload(screen.getByTestId('restore-archive-input'), file);
      await user.click(screen.getByTestId('confirm-archive-restore'));
    }

    beforeEach(() => {
      vi.stubGlobal('location', { reload: vi.fn() });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('calls it a partial success, and offers the reload the restore now depends on', async () => {
      vi.mocked(restoreArchive).mockResolvedValue({ images: 12, imagesMissed: 3 });
      const user = userEvent.setup();
      render(<RescueActions />);

      await restoreArchiveFile(user);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/your data was restored/i);
      expect(alert).toHaveTextContent('3 of 12');
      // The exact misreport this fixes: the data landed, so nothing here may say otherwise.
      expect(alert).not.toHaveTextContent(/failed/i);

      await user.click(screen.getByTestId('reload-after-partial-restore'));
      expect(location.reload).toHaveBeenCalledOnce();
    });

    it('says nothing when every image lands — that restore reloads on its own', async () => {
      vi.mocked(restoreArchive).mockResolvedValue({ images: 12, imagesMissed: 0 });
      const user = userEvent.setup();
      render(<RescueActions />);

      await restoreArchiveFile(user);

      await waitFor(() => expect(restoreArchive).toHaveBeenCalledOnce());
      expect(screen.queryByTestId('reload-after-partial-restore')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
