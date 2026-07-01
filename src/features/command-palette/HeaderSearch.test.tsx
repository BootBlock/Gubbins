import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { HeaderSearch } from './HeaderSearch';
import { useCommandPaletteStore } from './useCommandPaletteStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

beforeEach(() => {
  usePreferencesStore.setState({ dashboardCommandPalette: true });
  useCommandPaletteStore.setState({ open: false });
});
afterEach(cleanup);

describe('HeaderSearch — the command-palette launcher', () => {
  it('renders the search field when the feature is enabled', () => {
    render(<HeaderSearch />);
    expect(screen.getByTestId('dashboard-search-trigger')).toBeTruthy();
  });

  it('renders nothing when the feature is disabled', () => {
    usePreferencesStore.setState({ dashboardCommandPalette: false });
    render(<HeaderSearch />);
    expect(screen.queryByTestId('dashboard-search-trigger')).toBeNull();
  });

  it('opens the command palette when clicked', () => {
    render(<HeaderSearch />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
    fireEvent.click(screen.getByTestId('dashboard-search-trigger'));
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
