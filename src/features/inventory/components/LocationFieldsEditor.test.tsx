import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LocationFieldsEditor } from './LocationFieldsEditor';

/**
 * The add-a-field combobox keeps a fixed width (issue #435).
 *
 * The listbox popover is anchored to the trigger's width, so a trigger left to shrink to fit
 * its own text sizes the menu from whichever field happens to be selected — and the field
 * names inside the menu then truncate. jsdom lays nothing out, so the width itself cannot be
 * measured here; what these assertions pin is the property the bug turned on, that the box's
 * sizing does not vary with the selection.
 */

const defs = [
  { id: 'brand', name: 'Brand' },
  { id: 'long', name: 'Manufacturer part number and revision' },
];

vi.mock('../categories', () => ({
  useFieldDefs: () => ({ data: defs }),
  useLocationFieldValues: () => ({ data: [], isLoading: false }),
  useSetLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

/** The element whose width the trigger fills, and which the popover is therefore measured from. */
function sizingBox() {
  const combobox = screen.getByRole('combobox', { name: 'Custom field to add' });
  // trigger → the Select's `relative` root → the call site's sizing box.
  const box = combobox.parentElement?.parentElement;
  expect(box).not.toBeNull();
  return box!;
}

describe('LocationFieldsEditor add-field combobox', () => {
  it('sizes the box independently of the option that is selected', () => {
    render(<LocationFieldsEditor locationId="cabinet" />);

    const before = sizingBox().className;
    // A width class, not the shrink-to-fit `w-full`/auto the flex row would otherwise give it.
    expect(before).toMatch(/\bw-\d/);

    fireEvent.click(screen.getByRole('combobox', { name: 'Custom field to add' }));
    fireEvent.click(screen.getByRole('option', { name: 'Manufacturer part number and revision' }));

    expect(sizingBox().className).toBe(before);
  });
});
