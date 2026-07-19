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
  restoreRawSqlite: vi.fn(),
}));

vi.mock('@/features/archive/restore-archive', () => ({ restoreArchive: vi.fn() }));

vi.mock('@/features/errors', () => ({
  useErrorMessage: () => (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));

const actions = await import('./safe-mode-actions');

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
