import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmojiPicker } from './EmojiPicker';

/** Render the picker with spy callbacks; returns them plus a userEvent instance. */
function setup(props: Partial<React.ComponentProps<typeof EmojiPicker>> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<EmojiPicker open onClose={onClose} onSelect={onSelect} {...props} />);
  return { onClose, onSelect, user };
}

const search = () => screen.getByRole('combobox', { name: 'Search emoji' });
const grid = () => screen.getByRole('listbox', { name: 'Emoji' });

describe('EmojiPicker', () => {
  beforeEach(() => localStorage.clear());

  it('filters the catalogue as the user types', async () => {
    const { user } = setup();
    await user.type(search(), 'battery');
    expect(within(grid()).getByRole('option', { name: 'Battery' })).toBeInTheDocument();
    expect(within(grid()).queryByRole('option', { name: 'Rocket' })).not.toBeInTheDocument();
  });

  it('clears the filter (and keeps the dialog open) on Escape from a non-empty search box', async () => {
    const { onClose, user } = setup();
    await user.type(search(), 'battery');
    expect(search()).toHaveValue('battery');

    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cancels the dialog on Escape from an empty search box', async () => {
    const { onClose, user } = setup();
    search().focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the filter via the in-input clear button', async () => {
    const { user } = setup();
    await user.type(search(), 'battery');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search()).toHaveValue('');
  });

  it('commits a single-clicked emoji via the Use button', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'battery');
    await user.click(within(grid()).getByRole('option', { name: 'Battery' }));
    expect(screen.getByRole('button', { name: 'Use' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use' }));
    expect(onSelect).toHaveBeenCalledWith('🔋');
  });

  it('commits an emoji on double-click', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'battery');
    await user.dblClick(within(grid()).getByRole('option', { name: 'Battery' }));
    expect(onSelect).toHaveBeenCalledWith('🔋');
  });

  it('selects with the arrow keys and commits on Enter', async () => {
    const { onSelect, user } = setup();
    await user.type(search(), 'battery');
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('🔋');
  });

  it('preselects the initial emoji so Use is immediately available', () => {
    setup({ initialEmoji: '🔋' });
    expect(screen.getByRole('button', { name: 'Use' })).toBeEnabled();
    expect(within(grid()).getByRole('option', { name: 'Battery' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows a group when chosen from the rail', async () => {
    const { user } = setup();
    // Choosing "Food & drink" narrows the grid to food emoji.
    await user.click(screen.getByRole('option', { name: 'Food & drink' }));
    expect(within(grid()).getByRole('option', { name: 'Red apple' })).toBeInTheDocument();
    // A tool from the Objects group is no longer shown.
    expect(within(grid()).queryByRole('option', { name: 'Battery' })).not.toBeInTheDocument();
  });

  it('reports an empty result set', async () => {
    const { user } = setup();
    await user.type(search(), 'zzzznotanemoji');
    expect(within(grid()).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No emoji match/)).toBeInTheDocument();
  });
});
