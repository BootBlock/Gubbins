import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LocationFieldsEditor } from './LocationFieldsEditor';

/**
 * The add-a-field combobox is given a width of its own (issue #435).
 *
 * Left to the flex row it sits in, the box shrank to fit its own text — and because the
 * listbox popover is anchored to the trigger's width, that sized the menu from whichever
 * field happened to be selected, truncating the field names inside it. jsdom lays nothing
 * out, so the resulting width cannot be measured here; what this pins is the one thing that
 * *is* visible in the markup, and the thing whose removal caused the bug: the box carries an
 * explicit width class rather than sizing to its content.
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

describe('LocationFieldsEditor add-field combobox', () => {
  it('sits in a box with a width of its own, not the row default', () => {
    render(<LocationFieldsEditor locationId="cabinet" />);

    // trigger → the Select's `relative` root → the call site's sizing box, which is the
    // element `useAnchoredPopover` measures the menu from.
    const combobox = screen.getByRole('combobox', { name: 'Custom field to add' });
    const box = combobox.parentElement?.parentElement;

    // A fixed width (`w-<n>`); neither the bare flex row nor a `w-full` that would still
    // leave the trigger free to shrink to its text.
    expect(box?.className).toMatch(/\bw-\d/);
  });
});
