import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { DEAD_STOCK_DAYS_BOUNDS } from '@/features/settings/settings';

/**
 * Characterisation tests for {@link EditLocationDialog}.
 *
 * The dialog is a flat `Modal` holding the *whole* editable surface of a location. These
 * tests deliberately pin that surface field-by-field — every control it offers, the exact
 * payload a save dispatches, the dirty/validity gating on Save, and the read-only metadata
 * block — so a later restructuring of the layout cannot silently drop a field.
 *
 * Per the component-test conventions the react-query seams the dialog and its children
 * reach for (`../mutations`, `../tags`, `../categories`) are mocked; everything else —
 * the Foundry primitives, the pure parent-option/fullness seams, `useFormatters` — runs for
 * real, because those are exactly what the assertions are about.
 */

const spies = vi.hoisted(() => ({ update: vi.fn() }));
const updateState = vi.hoisted(() => ({ isPending: false }));

vi.mock('../mutations', () => ({
  useUpdateLocation: () => ({ mutate: spies.update, isPending: updateState.isPending }),
}));

// The nested tag editor (issue #84) reads react-query hooks; empty data renders it inertly.
vi.mock('../tags', () => ({
  useLocationTags: () => ({ data: [] }),
  useSetLocationTags: () => ({ mutate: vi.fn() }),
  useTagSuggestions: () => ({ data: [] }),
  useTagNames: () => ({ data: { rows: [] } }),
}));

// Same for the inheritable custom-field editor (issue #97).
vi.mock('../categories', () => ({
  useFieldDefs: () => ({ data: [] }),
  useLocationFieldValues: () => ({ data: [], isLoading: false }),
  useSetLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The real picker renders the whole ~1,700-glyph catalogue, which is far more work than this
// dialog's tests need — they only care that a chosen glyph reaches the save payload. The picker
// itself is covered by `GlyphPicker.test.tsx`.
vi.mock('@/components/foundry/glyph-picker/GlyphPicker', () => ({
  GlyphPicker: ({ onSelect }: { onSelect: (glyph: string) => void }) => (
    <button type="button" onClick={() => onSelect('Rocket')}>
      Pick Rocket
    </button>
  ),
}));

import { EditLocationDialog } from './EditLocationDialog';

/** Synthetic, COMPLETE location fixture (tests are excluded from tsc). */
function loc(overrides: Partial<LocationWithCount> = {}): LocationWithCount {
  return {
    id: 'cabinet',
    name: 'Cabinet A',
    parentId: 'workshop',
    isSystem: false,
    description: 'Small parts',
    color: 'teal',
    icon: 'Archive',
    capacity: null,
    isDefault: false,
    archivedAt: null,
    lastCountedAt: null,
    deadStockMode: 'inherit',
    deadStockDays: null,
    width: null,
    height: null,
    depth: null,
    usableVolume: null,
    packingFactor: null,
    walkOrder: null,
    updatedAt: 1_700_000_000_000,
    itemCount: 4,
    ...overrides,
  };
}

const workshop = loc({
  id: 'workshop',
  name: 'Workshop',
  parentId: null,
  description: null,
  color: null,
  icon: 'DoorOpen',
  itemCount: 9,
});
const drawer = loc({ id: 'drawer', name: 'Drawer 3', parentId: 'cabinet', itemCount: 1 });
const unassigned = loc({
  id: 'unassigned',
  name: 'Unassigned',
  parentId: null,
  isSystem: true,
  icon: null,
  color: null,
  itemCount: 0,
});

function renderDialog(
  overrides: Partial<LocationWithCount> = {},
  props: { onClose?: () => void; onDelete?: () => void; onToggleArchive?: () => void } = {},
) {
  const location = loc(overrides);
  const locations: LocationWithCount[] = [workshop, location, drawer, unassigned];
  const onClose = props.onClose ?? vi.fn();
  render(
    <EditLocationDialog
      open
      onClose={onClose}
      location={location}
      locations={locations}
      {...(props.onDelete ? { onDelete: props.onDelete } : {})}
      {...(props.onToggleArchive ? { onToggleArchive: props.onToggleArchive } : {})}
    />,
  );
  return { onClose, location };
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Edit location' }));
const saveButton = () => screen.getByRole('button', { name: 'Save changes' });

beforeEach(() => {
  spies.update.mockReset();
  updateState.isPending = false;
});
afterEach(cleanup);

describe('EditLocationDialog — the field surface', () => {
  it('renders every editable control the dialog offers', () => {
    renderDialog();
    const d = dialog();

    // Text fields.
    expect(d.getByLabelText('Name')).toBeInTheDocument();
    expect(d.getByLabelText('Description (optional)')).toBeInTheDocument();
    expect(d.getByLabelText('Capacity (optional)')).toBeInTheDocument();
    expect(d.getByLabelText('Walk order (optional)')).toBeInTheDocument();
    expect(d.getByLabelText('Idle threshold (optional)')).toBeInTheDocument();

    // The parent picker is a Foundry combobox named by its visible label.
    expect(d.getByRole('combobox', { name: 'Parent' })).toBeInTheDocument();

    // The icon picker's trigger, named by its own <label htmlFor>.
    expect(d.getByLabelText('Icon (optional)')).toBeInTheDocument();

    // The colour swatches' roving radiogroup, plus the segmented dead-stock group.
    expect(d.getByRole('radiogroup', { name: 'Colour (optional)' })).toBeInTheDocument();
    expect(d.getByRole('radiogroup', { name: 'Dead-stock reporting' })).toBeInTheDocument();
    expect(d.getByTestId('location-dead-stock-mode-inherit')).toBeInTheDocument();
    expect(d.getByTestId('location-dead-stock-mode-always')).toBeInTheDocument();
    expect(d.getByTestId('location-dead-stock-mode-never')).toBeInTheDocument();

    // The default-location checkbox.
    expect(
      d.getByRole('checkbox', { name: /Use as the default location for new items/ }),
    ).toBeInTheDocument();

    // The nested editors that persist on their own (tags, inheritable custom fields).
    expect(d.getByText('Tags (optional)')).toBeInTheDocument();

    // Footer actions. Nothing has been edited yet, so the dismiss action reads "Close".
    expect(d.getByTestId('edit-location-dismiss')).toHaveTextContent('Close');
    expect(d.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('seeds every control from the location being edited', () => {
    renderDialog({ capacity: 20, deadStockMode: 'always', deadStockDays: 45, isDefault: true });
    const d = dialog();

    expect(d.getByLabelText('Name')).toHaveValue('Cabinet A');
    expect(d.getByLabelText('Description (optional)')).toHaveValue('Small parts');
    expect(d.getByLabelText('Capacity (optional)')).toHaveValue('20');
    expect(d.getByLabelText('Idle threshold (optional)')).toHaveValue('45');
    expect(d.getByRole('checkbox', { name: /default location/ })).toBeChecked();
    // The parent combobox shows the stored parent's name.
    expect(d.getByRole('combobox', { name: 'Parent' })).toHaveTextContent('Workshop');
    // The stored colour / dead-stock mode are the checked radios; the icon trigger names its glyph.
    expect(d.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');
    expect(d.getByLabelText('Icon (optional)')).toHaveTextContent('Archive');
    expect(d.getByTestId('location-dead-stock-mode-always')).toHaveAttribute('aria-checked', 'true');
  });

  it('seeds a placed walk order and leaves the field blank when unplaced (issue #461)', () => {
    renderDialog({ walkOrder: 7 });
    const field = dialog().getByLabelText('Walk order (optional)');
    expect(field).toHaveValue('7');
    cleanup();
    renderDialog({ walkOrder: null });
    const blank = dialog().getByLabelText('Walk order (optional)');
    expect(blank).toHaveValue('');
    expect(blank).toHaveAttribute('placeholder', 'Not on the picking route');
  });

  it('falls back to the "none" choices for a location with no colour or icon', () => {
    renderDialog({ color: null, icon: null, parentId: null });
    const d = dialog();
    expect(d.getByRole('radio', { name: 'No colour' })).toHaveAttribute('aria-checked', 'true');
    expect(d.getByLabelText('Icon (optional)')).toHaveTextContent('Choose an icon');
    expect(d.getByRole('combobox', { name: 'Parent' })).toHaveTextContent('— Top level —');
  });

  it('lands initial focus in the Name field', () => {
    renderDialog();
    expect(document.activeElement).toBe(dialog().getByLabelText('Name'));
  });

  it('excludes the location itself and its descendants from the parent picker', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('combobox', { name: 'Parent' }));
    // A location may not move under itself…
    expect(screen.queryByRole('option', { name: /Cabinet A/ })).not.toBeInTheDocument();
    // …nor under its own child.
    expect(screen.queryByRole('option', { name: /Drawer 3/ })).not.toBeInTheDocument();
    // System locations are never valid parents either.
    expect(screen.queryByRole('option', { name: /Unassigned/ })).not.toBeInTheDocument();
    // A legitimate parent, and the synthetic top-level row, are offered.
    expect(screen.getByRole('option', { name: /Workshop/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '— Top level —' })).toBeInTheDocument();
  });
});

describe('EditLocationDialog — read-only metadata', () => {
  it('summarises items stored, sub-locations, path and last change', () => {
    renderDialog();
    const d = dialog();
    expect(d.getByText('Items stored')).toBeInTheDocument();
    expect(d.getByText('Sub-locations')).toBeInTheDocument();
    // Cabinet A has one child (Drawer 3) in the fixture tree.
    expect(d.getByText('1')).toBeInTheDocument();
    expect(d.getByText('Path')).toBeInTheDocument();
    expect(d.getByText('Workshop / Cabinet A')).toBeInTheDocument();
    expect(d.getByText('Last changed')).toBeInTheDocument();
    // The stored icon is echoed in the metadata block.
    expect(d.getByText('Icon')).toBeInTheDocument();
  });

  it('omits the Icon metadata row when the location has no icon', () => {
    renderDialog({ icon: null });
    expect(dialog().queryByText('Icon')).not.toBeInTheDocument();
  });

  it('shows a fullness bar and an "n / capacity" count only when a capacity is set', () => {
    renderDialog();
    // No capacity → no fullness row, and the plain item count.
    expect(dialog().queryByText('Fullness')).not.toBeInTheDocument();
    expect(dialog().getByText('4')).toBeInTheDocument();
    cleanup();

    renderDialog({ capacity: 8 });
    expect(dialog().getByText('Fullness')).toBeInTheDocument();
    expect(dialog().getByText('4 / 8')).toBeInTheDocument();
    expect(dialog().getByText('50%')).toBeInTheDocument();
  });
});

describe('EditLocationDialog — Save gating', () => {
  it('is disabled until something actually changes', () => {
    renderDialog();
    expect(saveButton()).toBeDisabled();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    expect(saveButton()).toBeEnabled();
  });

  it('re-disables when an edit is reverted back to the stored value', () => {
    renderDialog();
    const name = dialog().getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Cabinet B' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.change(name, { target: { value: 'Cabinet A' } });
    expect(saveButton()).toBeDisabled();
  });

  it('treats a whitespace-only rename as no change (the name is trimmed)', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: '  Cabinet A  ' } });
    expect(saveButton()).toBeDisabled();
  });

  it('is disabled for an empty name', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: '   ' } });
    expect(saveButton()).toBeDisabled();
  });

  it('is disabled while a save is in flight', () => {
    updateState.isPending = true;
    renderDialog();
    expect(saveButton()).toBeDisabled();
  });

  it('surfaces a capacity error and blocks the save', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Capacity (optional)'), { target: { value: '-2' } });
    expect(dialog().getByText('Capacity must be a whole number of 0 or more.')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('surfaces a walk-order error and blocks the save', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Walk order (optional)'), { target: { value: '-1' } });
    expect(dialog().getByText('Walk order must be a whole number of 0 or more.')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('disables Save for an out-of-range idle threshold, like an invalid capacity', () => {
    // The disabled guard once omitted `deadStockDaysValid` while `submit()` checked it, which
    // left a button that looked usable and silently did nothing. Both now agree.
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Idle threshold (optional)'), {
      target: { value: String(DEAD_STOCK_DAYS_BOUNDS.max + 1) },
    });
    expect(
      dialog().getByText(
        `Idle threshold must be between ${DEAD_STOCK_DAYS_BOUNDS.min} and ${DEAD_STOCK_DAYS_BOUNDS.max} days.`,
      ),
    ).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(spies.update).not.toHaveBeenCalled();
  });
});

describe('EditLocationDialog — saving', () => {
  const fullPayload = {
    name: 'Cabinet A',
    parentId: 'workshop',
    description: 'Small parts',
    color: 'teal',
    icon: 'Archive',
    capacity: null,
    isDefault: false,
    deadStockMode: 'inherit',
    deadStockDays: null,
    // An untouched dimension field re-saves its stored value; the fixture has none, so null.
    width: null,
    height: null,
    depth: null,
    usableVolume: null,
    packingFactor: null,
    // Walk order (issue #461) rides in the payload too; the fixture leaves it unplaced.
    walkOrder: null,
  };

  it('dispatches the whole location payload, not just the changed field', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    fireEvent.click(saveButton());

    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, name: 'Cabinet B' } },
      expect.anything(),
    );
  });

  it('Enter in the Name field submits the same way the button does', () => {
    renderDialog();
    const name = dialog().getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Cabinet B' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(spies.update).toHaveBeenCalledTimes(1);
  });

  it('normalises a blank description and a blank capacity to null', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Description (optional)'), { target: { value: '   ' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, description: null } },
      expect.anything(),
    );
  });

  it('normalises a cleared parent to null (moving the location to the top level)', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('combobox', { name: 'Parent' }));
    fireEvent.click(screen.getByRole('option', { name: '— Top level —' }));
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, parentId: null } },
      expect.anything(),
    );
  });

  it('saves a walk order, flooring a fractional value (issue #461)', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Walk order (optional)'), { target: { value: '3.9' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, walkOrder: 3 } },
      expect.anything(),
    );
  });

  it('clears a walk order back to null (off the picking route)', () => {
    renderDialog({ walkOrder: 5 });
    fireEvent.change(dialog().getByLabelText('Walk order (optional)'), { target: { value: '' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, walkOrder: null } },
      expect.anything(),
    );
  });

  it('floors a fractional capacity to a whole number', () => {
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Capacity (optional)'), { target: { value: '12.7' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, capacity: 12 } },
      expect.anything(),
    );
  });

  it('saves a changed colour swatch', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('radio', { name: 'Blue' }));
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, color: 'blue' } },
      expect.anything(),
    );
  });

  it('saves clearing the icon back to the plain folder', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('button', { name: 'Remove icon' }));
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, icon: null } },
      expect.anything(),
    );
  });

  it('saves a glyph chosen in the picker', async () => {
    renderDialog();
    // The picker is lazy-loaded, so its first paint is awaited rather than assumed.
    fireEvent.click(dialog().getByLabelText('Icon (optional)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Rocket' }));
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, icon: 'Rocket' } },
      expect.anything(),
    );
  });

  it('saves the default-location flag', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('checkbox', { name: /default location/ }));
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, isDefault: true } },
      expect.anything(),
    );
  });

  it('saves the dead-stock mode and idle threshold independently', () => {
    renderDialog();
    fireEvent.click(dialog().getByTestId('location-dead-stock-mode-never'));
    fireEvent.change(dialog().getByLabelText('Idle threshold (optional)'), { target: { value: '90' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, deadStockMode: 'never', deadStockDays: 90 } },
      expect.anything(),
    );
  });

  it('closes the dialog once the save succeeds', () => {
    spies.update.mockImplementation((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    const { onClose } = renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    fireEvent.click(saveButton());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows stored dimensions with a volume preview and threads an edit through', () => {
    // 400 × 300 × 250 mm = 30,000,000 mm³ = 30 L.
    renderDialog({ width: 400, height: 300, depth: 250 });
    expect((dialog().getByTestId('location-width') as HTMLInputElement).value).toBe('400');
    expect(dialog().getByTestId('location-volume-preview').textContent).toContain('30 L');

    fireEvent.change(dialog().getByTestId('location-depth'), { target: { value: '500' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, width: 400, height: 300, depth: 500 } },
      expect.anything(),
    );
  });

  it('hides the volume preview while a dimension is invalid, rather than showing a stale value', () => {
    renderDialog({ width: 100, height: 200, depth: 300 });
    expect(dialog().getByTestId('location-volume-preview')).toBeTruthy();
    // Typing rubbish keeps the stored value under the hood (so nothing is erased) but must not
    // leave a volume on screen that contradicts the "Enter a number." error beside the field.
    fireEvent.change(dialog().getByTestId('location-width'), { target: { value: 'abc' } });
    expect(dialog().queryByTestId('location-volume-preview')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('shows volumetric fullness with a coverage caption when the location is measured', () => {
    // 100×100×100 mm = 1,000,000 mm³ capacity; 500,000 used → 50%; 1 of 2 items measured.
    renderDialog({
      width: 100,
      height: 100,
      depth: 100,
      volumeTotals: { usedVolume: 500_000, measuredUnits: 1, totalUnits: 2, measuredItems: 1, totalItems: 2 },
    });
    expect(dialog().getByText('Fullness')).toBeInTheDocument();
    expect(dialog().getByText('50%')).toBeInTheDocument();
    expect(dialog().getByTestId('location-fullness-caption').textContent).toContain('1 of 2 items measured');
  });

  it('saves the advanced usable-volume and packing-factor overrides', () => {
    renderDialog();
    fireEvent.click(dialog().getByTestId('location-advanced-toggle'));
    fireEvent.change(dialog().getByTestId('location-packing-factor'), { target: { value: '70' } });
    fireEvent.click(saveButton());
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'cabinet', input: { ...fullPayload, packingFactor: 0.7 } },
      expect.anything(),
    );
  });

  it('surfaces a failed save in an alert and keeps the dialog open', () => {
    spies.update.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) =>
      opts?.onError?.(new Error('A location with that name already exists here.')),
    );
    const { onClose } = renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    fireEvent.click(saveButton());

    expect(screen.getByRole('alert')).toHaveTextContent('A location with that name already exists here.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the failure is not an Error', () => {
    spies.update.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) =>
      opts?.onError?.('boom'),
    );
    renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    fireEvent.click(saveButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save changes to this location.');
  });
});

describe('EditLocationDialog — closing and deleting', () => {
  it('names the dismiss action for what it actually does', () => {
    renderDialog();
    // Untouched: nothing would be lost, so offering to "Cancel" would imply otherwise.
    expect(dialog().getByTestId('edit-location-dismiss')).toHaveTextContent('Close');

    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    expect(dialog().getByTestId('edit-location-dismiss')).toHaveTextContent('Cancel');

    // Reverting the edit puts it back — the label tracks the dirty state, it does not latch.
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet A' } });
    expect(dialog().getByTestId('edit-location-dismiss')).toHaveTextContent('Close');
  });

  it('Cancel closes without saving', () => {
    const { onClose } = renderDialog();
    fireEvent.change(dialog().getByLabelText('Name'), { target: { value: 'Cabinet B' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('hides the delete action unless the caller supplies one', () => {
    renderDialog();
    expect(screen.queryByTestId('edit-location-delete')).not.toBeInTheDocument();
  });

  it('hands the delete decision back to the caller, without mutating anything itself', () => {
    const onDelete = vi.fn();
    const { onClose } = renderDialog({}, { onDelete });
    fireEvent.click(screen.getByTestId('edit-location-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    // The dialog neither closes nor saves — the caller owns the confirm-or-delete flow.
    expect(onClose).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('disables the delete action while a save is in flight', () => {
    updateState.isPending = true;
    renderDialog({}, { onDelete: vi.fn() });
    expect(screen.getByTestId('edit-location-delete')).toBeDisabled();
  });

  it('hides the archive action unless the caller supplies one', () => {
    renderDialog();
    expect(screen.queryByTestId('edit-location-archive')).not.toBeInTheDocument();
  });

  it('offers "Archive location" for a live location and hands the toggle back to the caller', () => {
    const onToggleArchive = vi.fn();
    const { onClose } = renderDialog({ archivedAt: null }, { onToggleArchive });
    const archive = screen.getByTestId('edit-location-archive');
    expect(archive).toHaveTextContent('Archive location');
    fireEvent.click(archive);
    expect(onToggleArchive).toHaveBeenCalledTimes(1);
    // The caller owns the state flip; the dialog itself neither closes nor saves.
    expect(onClose).not.toHaveBeenCalled();
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('offers "Restore location" instead when the location is already archived', () => {
    const onToggleArchive = vi.fn();
    renderDialog({ archivedAt: 1_700_000_000_000 }, { onToggleArchive });
    const archive = screen.getByTestId('edit-location-archive');
    expect(archive).toHaveTextContent('Restore location');
    fireEvent.click(archive);
    expect(onToggleArchive).toHaveBeenCalledTimes(1);
  });

  it('disables the archive action while a save is in flight', () => {
    updateState.isPending = true;
    renderDialog({}, { onToggleArchive: vi.fn() });
    expect(screen.getByTestId('edit-location-archive')).toBeDisabled();
  });

  it('renders nothing when closed', () => {
    render(
      <EditLocationDialog
        open={false}
        onClose={vi.fn()}
        location={loc()}
        locations={[workshop, loc(), drawer]}
      />,
    );
    expect(screen.queryByRole('dialog', { name: 'Edit location' })).not.toBeInTheDocument();
  });
});
