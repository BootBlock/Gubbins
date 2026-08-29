import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry';
import { emptyItemReferenceCounts, type DuplicateScanItem, type MergeItemsInput } from '@/db/repositories';
import { DeduplicateItemsDialog } from './DeduplicateItemsDialog';
import type { DuplicateGroup, DuplicateScanOptions } from './duplicate-groups';

/**
 * The Deduplicate-items dialog (issue #99). Pins the wiring the user's data depends on: nothing is
 * scanned until they ask, the keeper defaults to the member holding the most stock but is theirs
 * to change, and the merge is called once per ticked member with the pair the card names.
 */

let scanOptions: DuplicateScanOptions | null = null;
let groups: DuplicateGroup<DuplicateScanItem>[] = [];
// Whether the query is mid-refetch. A re-scan with unchanged options keeps the previous `data`
// on screen while it refetches, which is exactly the state the dialog has to hide.
let fetching = false;
const refetchSpy = vi.fn();
const mergeSpy = vi.fn<(input: MergeItemsInput) => Promise<unknown>>();

vi.mock('../queries', () => ({
  useDuplicateScan: (options: DuplicateScanOptions | null) => {
    scanOptions = options;
    return {
      data: options ? { groups, scanned: 9, total: 9, truncated: false } : undefined,
      isError: false,
      isFetching: fetching,
      refetch: refetchSpy,
    };
  },
  useItemReferenceCounts: () => ({ data: undefined }),
}));

vi.mock('../mutations', () => ({
  useMergeItems: () => ({ mutateAsync: mergeSpy }),
}));

function member(over: Partial<DuplicateScanItem> & { readonly id: string }): DuplicateScanItem {
  return {
    name: `Item ${over.id}`,
    barcode: null,
    serialNumber: null,
    mpn: null,
    manufacturer: null,
    quantity: 0,
    createdAt: 1,
    serialNo: null,
    locationName: 'Drawer',
    ...over,
  };
}

beforeEach(() => {
  scanOptions = null;
  fetching = false;
  refetchSpy.mockReset();
  mergeSpy.mockReset();
  mergeSpy.mockResolvedValue({
    remapped: emptyItemReferenceCounts(),
    discarded: emptyItemReferenceCounts(),
    demotedSupplierFlags: 0,
  });
  groups = [
    {
      id: 'a',
      signals: ['name'],
      members: [member({ id: 'a', quantity: 1 }), member({ id: 'b', quantity: 7 }), member({ id: 'c' })],
    },
  ];
});
afterEach(cleanup);

function renderDialog() {
  render(
    <ToastProvider>
      <DeduplicateItemsDialog open onClose={vi.fn()} />
    </ToastProvider>,
  );
}

describe('DeduplicateItemsDialog', () => {
  it('scans nothing until the user asks it to', () => {
    renderDialog();
    expect(scanOptions).toBeNull();
    expect(screen.queryByTestId('dedupe-group')).toBeNull();
  });

  it('scans with the signals that are ticked', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-signal-barcode'));
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    expect(scanOptions?.signals).toEqual(['name', 'serial', 'mpn']);
  });

  it('refuses to scan with nothing to match on', () => {
    renderDialog();
    for (const signal of ['name', 'barcode', 'serial', 'mpn']) {
      fireEvent.click(screen.getByTestId(`dedupe-signal-${signal}`));
    }
    expect(screen.getByTestId('dedupe-scan')).toBeDisabled();
  });

  it('proposes the member holding the most stock as the one to keep', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    const keeps = screen.getAllByTestId('dedupe-keep') as HTMLInputElement[];
    // Members are listed by name — Item a, Item b, Item c — and Item b holds seven.
    expect(keeps.map((r) => r.checked)).toEqual([false, true, false]);
  });

  it('merges every ticked member into the kept one, one call each', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    await waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(2));
    expect(mergeSpy.mock.calls.map(([input]) => input)).toEqual([
      { keepId: 'b', removeId: 'a', remapReferences: true },
      { keepId: 'b', removeId: 'c', remapReferences: true },
    ]);
  });

  it('follows the user’s choice of keeper rather than its own proposal', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    const keeps = screen.getAllByTestId('dedupe-keep');
    fireEvent.click(keeps[2]!); // Item c
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    await waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(2));
    expect(mergeSpy.mock.calls.every(([input]) => input.keepId === 'c')).toBe(true);
  });

  it('leaves out a member the user unticks', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getAllByTestId('dedupe-remove')[0]!);
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    await waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
    expect(mergeSpy.mock.calls[0]![0]!.removeId).toBe('c');
  });

  it('passes the re-point choice through when the user turns it off', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-remap'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    await waitFor(() => expect(mergeSpy).toHaveBeenCalled());
    expect(mergeSpy.mock.calls.every(([input]) => input.remapReferences === false)).toBe(true);
  });

  it('replaces a merged card’s controls with what happened, so it cannot be merged twice', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    const outcome = await screen.findByTestId('dedupe-group-outcome');
    expect(outcome).toHaveTextContent('2 items merged and removed.');
    expect(screen.queryByTestId('dedupe-merge')).toBeNull();
  });

  it('reports a member that could not be merged rather than swallowing it', async () => {
    mergeSpy.mockRejectedValueOnce(new Error('nope'));
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    const outcome = await screen.findByTestId('dedupe-group-outcome');
    expect(within(outcome).getByText(/couldn’t be merged/)).toBeInTheDocument();
    // The failure does not abandon the rest of the cluster.
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    // One merged, so the card is a record now.
    expect(screen.queryByTestId('dedupe-merge')).toBeNull();
  });

  it('leaves a group that merged nothing retryable, and does not call it merged', async () => {
    mergeSpy.mockRejectedValue(new Error('nope'));
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));

    const outcome = await screen.findByTestId('dedupe-group-outcome');
    expect(within(outcome).getByText(/couldn’t be merged/)).toBeInTheDocument();
    expect(within(outcome).queryByText(/merged and removed/)).toBeNull();
    // The database is as it was, so the controls stay and the user can try again.
    expect(screen.getByTestId('dedupe-merge')).toBeEnabled();
  });

  it('hides a stale result while a re-scan is in flight, so a merged card cannot be re-armed', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('dedupe-scan'));
    fireEvent.click(screen.getByTestId('dedupe-merge'));
    await screen.findByTestId('dedupe-group-outcome');

    // Re-scanning with the same options keeps the old `data` while it refetches. Without the
    // gate the outcome would clear and the card would offer to merge items that are already gone.
    fetching = true;
    fireEvent.click(screen.getByTestId('dedupe-scan'));

    expect(refetchSpy).toHaveBeenCalled();
    expect(screen.queryByTestId('dedupe-group')).toBeNull();
    expect(screen.queryByTestId('dedupe-merge')).toBeNull();
  });
});
