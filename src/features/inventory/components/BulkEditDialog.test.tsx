import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Behaviour tests for the {@link BulkEditDialog} glue (Phase 76). The pure spec maths lives in
 * `bulk-edit.ts` (covered by bulk-edit.test.ts); this pins the *dialog's* contract: how the
 * per-field enable checkboxes assemble a {@link BulkEditSpec}, the "nothing to do" Apply gate,
 * and the apply → `mutateAsync` → success/failure announcement → close flow — the high-stakes
 * path that edits every selected item at once. Per the component-test conventions, `../mutations`
 * and the other hooks the dialog uses are mocked; the pure `bulk-edit` seam is used for real.
 */

const mutateAsync = vi.fn();
vi.mock('../mutations', () => ({
  useBulkEditItems: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: [{ id: 'cat-1', name: 'Capacitors' }] } }),
}));
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({ quantity: (n: number) => String(n) }),
}));

import { BulkEditDialog } from './BulkEditDialog';

const onClose = vi.fn();
const onApplied = vi.fn();

function renderDialog(props: Partial<React.ComponentProps<typeof BulkEditDialog>> = {}) {
  return render(
    <BulkEditDialog
      open
      onClose={onClose}
      itemIds={['a', 'b', 'c']}
      locations={[]}
      onApplied={onApplied}
      {...props}
    />,
  );
}

const applyButton = () => screen.getByTestId('bulk-edit-apply');

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({ succeeded: 3, failed: 0 });
  onClose.mockReset();
  onApplied.mockReset();
});
afterEach(cleanup);

describe('BulkEditDialog — the Apply gate', () => {
  it('disables Apply until at least one field is enabled', () => {
    renderDialog();
    expect(applyButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('bulk-field-active'));
    expect(applyButton()).toBeEnabled();
  });

  it('keeps Apply disabled when there are no selected items, even with a field enabled', () => {
    renderDialog({ itemIds: [] });
    fireEvent.click(screen.getByTestId('bulk-field-active'));
    expect(applyButton()).toBeDisabled();
  });

  it('treats an enabled Tags field with no names as nothing to do', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-tags'));
    // The tag input is empty, so the spec carries no tag names → still nothing to apply.
    expect(applyButton()).toBeDisabled();
  });
});

describe('BulkEditDialog — spec assembled from the enable checkboxes', () => {
  it('applies the default active-state and announces the result, then closes', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-active')); // State defaults to "Active"
    fireEvent.click(applyButton());

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        ids: ['a', 'b', 'c'],
        spec: { active: { value: true } },
      }),
    );
    expect(onApplied).toHaveBeenCalledWith('Updated 3 items.');
    expect(onClose).toHaveBeenCalled();
  });

  it('enabling Category with no selection clears it (value null), distinct from untouched', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-category')); // enabled, but value left at ""
    fireEvent.click(applyButton());

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        ids: ['a', 'b', 'c'],
        spec: { category: { value: null } },
      }),
    );
  });

  it('sends the chosen category id when one is picked from the Select', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-category'));
    // Foundry Select is a custom listbox — open it and click the option (not selectOption).
    fireEvent.click(screen.getByRole('combobox', { name: 'New category' }));
    fireEvent.click(screen.getByRole('option', { name: 'Capacitors' }));
    fireEvent.click(applyButton());

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        ids: ['a', 'b', 'c'],
        spec: { category: { value: 'cat-1' } },
      }),
    );
  });

  it('parses the comma-separated tag input into the add-mode spec', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-tags'));
    fireEvent.change(screen.getByLabelText('Tag names'), { target: { value: ' fragile, restock ,' } });
    fireEvent.click(applyButton());

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        ids: ['a', 'b', 'c'],
        spec: { tags: { mode: 'add', names: ['fragile', 'restock'] } },
      }),
    );
  });
});

describe('BulkEditDialog — outcome message', () => {
  it('reports the failed count when some items could not be updated', async () => {
    mutateAsync.mockResolvedValue({ succeeded: 2, failed: 1 });
    renderDialog();
    fireEvent.click(screen.getByTestId('bulk-field-active'));
    fireEvent.click(applyButton());

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith('Updated 2 items; 1 failed.'));
  });
});
