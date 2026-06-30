import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Router: only useNavigate is needed by the palette.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

// Item search returns a fixed page of rows; the palette only reads id + name.
vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({
    data: { pages: [{ rows: [{ id: 'i1', name: '10k resistor' }, { id: 'i2', name: '220 ohm resistor' }] }] },
    isPending: false,
  }),
}));

import { CommandPalette } from './CommandPalette';
import { useCommandPaletteStore } from './useCommandPaletteStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

beforeEach(() => {
  navigateMock.mockClear();
  usePreferencesStore.setState({ dashboardCommandPalette: true });
  useCommandPaletteStore.setState({ open: false });
  useInventoryEntry.setState({ pendingSearch: null, pendingIntent: null });
});
afterEach(cleanup);

describe('CommandPalette', () => {
  it('renders nothing when the feature is disabled', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('renders nothing while closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-input')).toBeNull();
  });

  it('shows live results once a query is typed', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    fireEvent.change(screen.getByTestId('command-palette-input'), { target: { value: 'resistor' } });
    const results = await screen.findAllByTestId('command-palette-result');
    expect(results).toHaveLength(2);
    expect(results[0].textContent).toContain('10k resistor');
  });

  it('selecting a result hands the name to inventory and navigates there', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useInventoryEntry.getState().pendingSearch).toBe('10k resistor');
    expect(navigateMock).toHaveBeenCalledWith({ to: '/inventory' });
    // The palette closes itself on select.
    await waitFor(() => expect(screen.queryByTestId('command-palette-input')).toBeNull());
  });

  it('shows a clear button only when there is text, and clearing empties the box', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input') as HTMLInputElement;
    expect(screen.queryByTestId('command-palette-clear')).toBeNull();
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.click(screen.getByTestId('command-palette-clear'));
    expect(input.value).toBe('');
    expect(screen.queryByTestId('command-palette-clear')).toBeNull();
    expect(screen.queryAllByTestId('command-palette-result')).toHaveLength(0);
  });

  it('arrow keys move the active result before Enter selects it', async () => {
    useCommandPaletteStore.setState({ open: true });
    render(<CommandPalette />);
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'resistor' } });
    await screen.findAllByTestId('command-palette-result');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useInventoryEntry.getState().pendingSearch).toBe('220 ohm resistor');
  });
});
