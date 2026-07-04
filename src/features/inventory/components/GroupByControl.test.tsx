import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { GroupByControl } from './GroupByControl';

/**
 * The "Group by" arrangement chooser. Drives the real {@link useLayoutStore}, so it also
 * covers that the store's grouping axis round-trips. The Foundry Select is a custom listbox,
 * so a choice is a click-open + click-option (per [[foundry-select-combobox]]).
 */

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ grouping: 'none' });
});

describe('GroupByControl', () => {
  it('shows the active mode on the trigger', () => {
    useLayoutStore.setState({ grouping: 'location' });
    render(<GroupByControl />);
    expect(screen.getByTestId('group-by-control')).toHaveTextContent('By location');
  });

  it('switches the grouping mode when an option is chosen', () => {
    render(<GroupByControl />);
    expect(useLayoutStore.getState().grouping).toBe('none');
    fireEvent.click(screen.getByTestId('group-by-control'));
    fireEvent.click(screen.getByRole('option', { name: 'By location' }));
    expect(useLayoutStore.getState().grouping).toBe('location');
  });
});
