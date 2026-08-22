import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationWithCount } from '@/db/repositories';
import { CreateLocationDialog } from './CreateLocationDialog';

const spies = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../mutations', () => ({
  useCreateLocationPath: () => ({ mutate: spies.create, isPending: false }),
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

afterEach(() => {
  cleanup();
  spies.create.mockReset();
});

const locations: LocationWithCount[] = [];

function renderDialog() {
  render(<CreateLocationDialog open onClose={() => {}} locations={locations} />);
}

describe('CreateLocationDialog', () => {
  it('lands initial focus in the Name field, ready to type', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('tints the Name text with the chosen colour swatch', () => {
    renderDialog();
    const name = screen.getByLabelText('Name');
    expect(name.className).not.toContain('text-loc-teal');
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));
    expect(name.className).toContain('text-loc-teal');
  });

  it('offers an Icon picker, a Capacity field and a Default toggle', () => {
    renderDialog();
    expect(screen.getByLabelText('Icon (optional)').textContent).toContain('Choose an icon');
    expect(screen.getByLabelText('Capacity (optional)')).toBeTruthy();
    expect(screen.getByLabelText(/default location for new items/i)).toBeTruthy();
  });

  it('gives every field an information badge', () => {
    renderDialog();
    // Name, Parent, Description, Icon, Colour, Capacity, Dimensions, Default.
    expect(screen.getAllByLabelText('More information')).toHaveLength(8);
  });

  it('submits the richer metadata, including the glyph chosen in the picker', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cabinet A' } });
    // The picker is lazy-loaded, so its first paint is awaited rather than assumed.
    fireEvent.click(screen.getByLabelText('Icon (optional)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Pick Rocket' }));
    fireEvent.change(screen.getByLabelText('Capacity (optional)'), { target: { value: '20' } });
    fireEvent.click(screen.getByLabelText(/default location for new items/i));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({
      name: 'Cabinet A',
      icon: 'Rocket',
      capacity: 20,
      isDefault: true,
    });
  });

  it('shows a derived-volume preview and stores the dimensions in canonical mm', () => {
    renderDialog();
    // The default dimension unit is mm, so the entered numbers are stored verbatim.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Drawer' } });
    expect(screen.queryByTestId('location-volume-preview')).toBeNull();
    fireEvent.change(screen.getByTestId('location-width'), { target: { value: '300' } });
    fireEvent.change(screen.getByTestId('location-height'), { target: { value: '200' } });
    // Only complete once all three are present.
    expect(screen.queryByTestId('location-volume-preview')).toBeNull();
    fireEvent.change(screen.getByTestId('location-depth'), { target: { value: '150' } });

    // 300 × 200 × 150 mm = 9,000,000 mm³ = 9 L (auto volume unit for a metric drawer).
    expect(screen.getByTestId('location-volume-preview').textContent).toContain('9 L');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(spies.create.mock.calls[0][0]).toMatchObject({ width: 300, height: 200, depth: 150 });
  });

  it('saves the advanced usable-volume and packing-factor overrides', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bag' } });
    // The overrides live behind a collapsed disclosure so the common case stays three fields.
    expect(screen.queryByTestId('location-usable-volume')).toBeNull();
    fireEvent.click(screen.getByTestId('location-advanced-toggle'));
    // Default dimension unit is mm (metric), so usable volume is entered in litres.
    fireEvent.change(screen.getByTestId('location-usable-volume'), { target: { value: '2' } }); // 2 L
    fireEvent.change(screen.getByTestId('location-packing-factor'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(spies.create.mock.calls[0][0]).toMatchObject({ usableVolume: 2_000_000, packingFactor: 0.7 });
  });

  it('blocks Create on a negative dimension rather than silently clearing it', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByTestId('location-width'), { target: { value: '-5' } });
    expect(screen.getByText('Must be 0 or more.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('rejects a below-floor packing factor and keeps the error visible even if collapsed', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bin' } });
    fireEvent.click(screen.getByTestId('location-advanced-toggle'));
    // 3% is below the 5% floor the global default is clamped to — blocked, not silently accepted.
    fireEvent.change(screen.getByTestId('location-packing-factor'), { target: { value: '3' } });
    expect(screen.getByText('Enter 5–100.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(true);
    // Collapsing must not hide a blocking error, or the disabled button would have no reason.
    fireEvent.click(screen.getByTestId('location-advanced-toggle'));
    expect(screen.getByTestId('location-packing-factor')).toBeTruthy();
    expect(screen.getByText('Enter 5–100.')).toBeTruthy();
  });

  it('passes a slash-separated path through verbatim so the repo splits it', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Workshop/Cabinet A/Drawer 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({ name: 'Workshop/Cabinet A/Drawer 3' });
  });

  it('previews the nested levels a path will create', () => {
    renderDialog();
    // No preview for a plain single-level name.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Workshop' } });
    expect(screen.queryByText(/Existing levels are reused/i)).toBeNull();

    // A separator reveals the chain of levels.
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Workshop/Cabinet A/Drawer 3' },
    });
    const preview = screen.getByText(/Existing levels are reused/i);
    expect(preview).toHaveTextContent('Workshop');
    expect(preview).toHaveTextContent('Cabinet A');
    expect(preview).toHaveTextContent('Drawer 3');
  });

  it('previews comma-separated siblings as a fanned-out set', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Garage/Box 1, Box 2, Box 3' },
    });
    const preview = screen.getByText(/Existing levels are reused/i);
    expect(preview).toHaveTextContent('Garage');
    expect(preview).toHaveTextContent('Box 1');
    expect(preview).toHaveTextContent('Box 2');
    expect(preview).toHaveTextContent('Box 3');
    expect(preview).toHaveTextContent(/as siblings/i);
  });

  it('keeps the Name control findable by its label once the preview shows', () => {
    // The preview lives outside FormField's <label>, so it must not fold into the control's
    // accessible name — the field stays queryable by exactly "Name".
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Garage/Box 1, Box 2' },
    });
    expect(screen.getByText(/Existing levels are reused/i)).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('passes a comma-separated sibling list through verbatim for the repo to fan out', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Garage/Box 1, Box 2, Box 3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toMatchObject({ name: 'Garage/Box 1, Box 2, Box 3' });
  });

  it('disables the Default toggle while several siblings are being created', () => {
    renderDialog();
    const toggle = screen.getByLabelText(/default location for new items/i);
    // Tick it for a single location…
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();

    // …then fan out siblings: the toggle unchecks and disables (no single default possible).
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Garage/Box 1, Box 2' } });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/only a single location can be the default/i)).toBeTruthy();

    // Back to one leaf and the earlier choice is restored, not lost.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Garage/Box 1' } });
    expect(toggle).not.toBeDisabled();
    expect(toggle).toBeChecked();
  });

  it('never sets isDefault when fanning out siblings, even if it was ticked first', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText(/default location for new items/i));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Garage/Box 1, Box 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(spies.create.mock.calls[0][0]).toMatchObject({ isDefault: false });
  });

  it('keeps Create disabled when the name is only separators or blank', () => {
    renderDialog();
    const createButton = screen.getByRole('button', { name: 'Create' });
    expect(createButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' / \\ ' } });
    expect(createButton).toBeDisabled();
    // A leaf that is only commas has no usable sibling names, so still nothing to create.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' , , ' } });
    expect(createButton).toBeDisabled();
  });
});
