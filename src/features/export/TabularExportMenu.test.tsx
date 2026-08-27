/**
 * Tests for the shared export menu's own behaviour — specifically the caveat channel added for
 * issue #132.
 *
 * A list export re-reads its whole list, and an unbounded one (the activity ledger) can stop at
 * the read-everything ceiling with rows still unread. The document `caption` can only say so in
 * the formats that have one, and CSV — the most-used format — has nowhere to put it, so the toast
 * is the one channel every format shares. These assert the file still saves, and that the user is
 * actually told when it stopped short.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/foundry';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { TabularExportMenu } from './TabularExportMenu';
import type { TabularExportResult } from './tabular-export';

const download = vi.hoisted(() => vi.fn());
vi.mock('./download', () => ({ download }));

const COMPLETE: TabularExportResult = { content: 'a,b', mimeType: 'text/csv', extension: 'csv' };

function renderMenu(build: () => Promise<TabularExportResult>) {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <TabularExportMenu
        build={build}
        filename={(extension) => `list.${extension}`}
        triggerLabel="Export"
        menuLabel="Export list"
        toastHeading="List exported"
        testIdPrefix="export-list"
      />
    </ToastProvider>,
  );
  return { user };
}

// Every assertion above this line runs as single-user mode does — unrestricted — so the authority
// is reset on both edges rather than only before, or the one restricted test below would leak its
// grants into whatever ran next.
beforeEach(() => {
  download.mockClear();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY }));

describe('TabularExportMenu — a complete export', () => {
  it('saves the file and reports plain success', async () => {
    const { user } = renderMenu(() => Promise.resolve(COMPLETE));
    await user.click(screen.getByTestId('export-list'));
    await user.click(screen.getByTestId('export-list-csv'));

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('list.csv saved to your downloads.')).toBeInTheDocument();
    expect(screen.getByText('List exported')).toBeInTheDocument();
  });
});

describe('TabularExportMenu — an export that stopped short', () => {
  it('still saves the file — a short file is better than none', async () => {
    const { user } = renderMenu(() => Promise.resolve({ ...COMPLETE, notice: 'It stops short.' }));
    await user.click(screen.getByTestId('export-list'));
    await user.click(screen.getByTestId('export-list-csv'));

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it('tells the user the file is incomplete instead of reporting a clean success', async () => {
    const { user } = renderMenu(() => Promise.resolve({ ...COMPLETE, notice: 'It stops short.' }));
    await user.click(screen.getByTestId('export-list'));
    await user.click(screen.getByTestId('export-list-csv'));

    expect(await screen.findByText('list.csv saved to your downloads. It stops short.')).toBeInTheDocument();
  });

  it('surfaces the failure toast when the file could not be built at all', async () => {
    const { user } = renderMenu(() => Promise.reject(new Error('no')));
    await user.click(screen.getByTestId('export-list'));
    await user.click(screen.getByTestId('export-list-csv'));

    expect(await screen.findByText('Export failed')).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('TabularExportMenu — the export:run gate (issue #429)', () => {
  it('offers the menu to a session that holds export:run', () => {
    useSessionStore.setState({
      authority: { mode: 'granted', grants: new Set(['items:read', 'export:run']) },
    });
    renderMenu(() => Promise.resolve(COMPLETE));

    expect(screen.getByTestId('export-list')).toBeInTheDocument();
  });

  it('renders nothing at all for a session refused export:run', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['items:read']) } });
    renderMenu(() => Promise.resolve(COMPLETE));

    // Hidden, not disabled: a greyed-out trigger would still advertise the capability, and the
    // gate is here so that every call site inherit it without a check of their own.
    expect(screen.queryByTestId('export-list')).not.toBeInTheDocument();
  });
});
