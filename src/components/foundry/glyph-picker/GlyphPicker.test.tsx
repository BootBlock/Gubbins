import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GlyphPicker } from './GlyphPicker';

/** Render the picker with spy callbacks; returns them plus a userEvent instance. */
function setup(props: Partial<React.ComponentProps<typeof GlyphPicker>> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<GlyphPicker open onClose={onClose} onSelect={onSelect} {...props} />);
  return { onClose, onSelect, user };
}

const search = () => screen.getByRole('combobox', { name: 'Search icons' });

describe('GlyphPicker', () => {
  it('filters the catalogue as the user types', async () => {
    const { user } = setup();
    // The full catalogue shows a "House" glyph up front.
    expect(screen.getByRole('option', { name: 'House' })).toBeInTheDocument();

    await user.type(search(), 'rocket');

    expect(screen.getByRole('option', { name: 'Rocket' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'House' })).not.toBeInTheDocument();
  });

  it('clears the filter (and keeps the dialog open) on Escape from a non-empty search box', async () => {
    const { onClose, user } = setup();
    await user.type(search(), 'rocket');
    expect(search()).toHaveValue('rocket');

    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    // The catalogue is back in full — the previously-hidden House glyph returns.
    expect(screen.getByRole('option', { name: 'House' })).toBeInTheDocument();
  });

  it('cancels the dialog on Escape from an empty search box', async () => {
    const { onClose, user } = setup();
    search().focus();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('commits a single-clicked glyph via the Use button', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'rocket');

    await user.click(screen.getByRole('option', { name: 'Rocket' }));
    expect(screen.getByRole('button', { name: 'Use' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use' }));

    expect(onSelect).toHaveBeenCalledWith('Rocket');
  });

  it('commits a glyph on double-click', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'rocket');

    await user.dblClick(screen.getByRole('option', { name: 'Rocket' }));

    expect(onSelect).toHaveBeenCalledWith('Rocket');
  });

  it('selects with the arrow keys and commits on Enter', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'rocket');

    // Nothing highlighted yet — the first arrow lands on the first (only) match.
    await user.keyboard('{ArrowRight}{Enter}');

    expect(onSelect).toHaveBeenCalledWith('Rocket');
  });

  it('preselects the initial glyph so Use is immediately available', () => {
    setup({ initialGlyph: 'Rocket' });

    const useButton = screen.getByRole('button', { name: 'Use' });
    expect(useButton).toBeEnabled();
    const selectedOption = screen.getByRole('option', { name: 'Rocket' });
    expect(selectedOption).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores an unknown initialGlyph (Use stays disabled)', () => {
    setup({ initialGlyph: 'NotARealGlyphName' });
    expect(screen.getByRole('button', { name: 'Use' })).toBeDisabled();
  });

  it('reports an empty result set', async () => {
    const { user } = setup();
    await user.type(search(), 'zzzzznotanicon');
    const listbox = screen.getByRole('listbox', { name: 'Icons' });
    expect(within(listbox).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No icons match/)).toBeInTheDocument();
  });
});
