import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SavedSearchMenu } from './SavedSearchMenu';
import { useSavedSearchesStore } from '../useSavedSearchesStore';

beforeEach(() => {
  useSavedSearchesStore.setState({ searches: [] });
  localStorage.clear();
});
afterEach(cleanup);

describe('SavedSearchMenu — saved text searches (spec §3, Phase 48)', () => {
  it('saves the current query under a name and shows it as a chip', () => {
    render(<SavedSearchMenu currentQuery="cap:voltage>3.3 qty<10" onRecall={() => {}} />);

    fireEvent.click(screen.getByTestId('saved-search-save'));
    fireEvent.change(screen.getByTestId('saved-search-name'), { target: { value: 'High voltage' } });
    fireEvent.click(screen.getByTestId('saved-search-confirm'));

    expect(screen.getByTestId('saved-search-recall').textContent).toBe('High voltage');
    expect(useSavedSearchesStore.getState().searches).toHaveLength(1);
  });

  it('disables Save when the query is empty', () => {
    render(<SavedSearchMenu currentQuery="   " onRecall={() => {}} />);
    expect(screen.getByTestId('saved-search-save')).toBeDisabled();
  });

  it('recalls a saved query through onRecall', () => {
    useSavedSearchesStore.setState({
      searches: [{ id: '1', name: 'Caps', query: 'cap:rohs' }],
    });
    const onRecall = vi.fn();
    render(<SavedSearchMenu currentQuery="" onRecall={onRecall} />);

    fireEvent.click(screen.getByTestId('saved-search-recall'));
    expect(onRecall).toHaveBeenCalledWith('cap:rohs');
  });

  it('deletes a saved search', () => {
    useSavedSearchesStore.setState({
      searches: [{ id: '1', name: 'Caps', query: 'cap:rohs' }],
    });
    render(<SavedSearchMenu currentQuery="" onRecall={() => {}} />);

    fireEvent.click(screen.getByLabelText('Delete saved search Caps'));
    expect(screen.queryByTestId('saved-search-chip')).toBeNull();
    expect(useSavedSearchesStore.getState().searches).toHaveLength(0);
  });
});
