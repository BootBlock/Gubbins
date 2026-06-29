import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SearchBuilderProvider, useSearchBuilder } from '../SearchBuilderContext';
import { useSavedSearchesStore } from '../useSavedSearchesStore';
import { TextQueryInput } from './TextQueryInput';

beforeEach(() => {
  useSavedSearchesStore.setState({ searches: [] });
  localStorage.clear();
});
afterEach(cleanup);

/** A tiny probe that exposes the live AST condition count beside the input. */
function Probe() {
  const { conditionCount } = useSearchBuilder();
  return <output data-testid="count">{conditionCount}</output>;
}

function renderWithBuilder() {
  return render(
    <SearchBuilderProvider>
      <TextQueryInput />
      <Probe />
    </SearchBuilderProvider>,
  );
}

describe('TextQueryInput — hybrid text search (spec §3, Phase 47)', () => {
  it('parses a valid query into the builder AST on submit', () => {
    renderWithBuilder();
    const input = screen.getByTestId('text-search-input');
    fireEvent.change(input, { target: { value: 'cap:voltage>3.3 quantity<10' } });
    fireEvent.submit(input);
    // Two leaf conditions loaded into the shared Tier-3 tree.
    expect(screen.getByTestId('count').textContent).toBe('2');
    expect(screen.queryByTestId('text-search-error')).toBeNull();
  });

  it('surfaces a parse error and leaves the tree untouched', () => {
    renderWithBuilder();
    const input = screen.getByTestId('text-search-input');
    fireEvent.change(input, { target: { value: 'quantity>lots' } });
    fireEvent.submit(input);
    expect(screen.getByTestId('text-search-error')).toBeTruthy();
    // Nothing was dispatched — the builder stays empty.
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('clears a prior error once the user edits the query', () => {
    renderWithBuilder();
    const input = screen.getByTestId('text-search-input');
    fireEvent.change(input, { target: { value: 'name>oops' } });
    fireEvent.submit(input);
    expect(screen.getByTestId('text-search-error')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'name:ok' } });
    expect(screen.queryByTestId('text-search-error')).toBeNull();
  });

  it('loads an OR / parenthesised query (Phase 48 grammar depth)', () => {
    renderWithBuilder();
    const input = screen.getByTestId('text-search-input');
    fireEvent.change(input, { target: { value: 'cap:voltage>3.3 (qty<10 OR mfr:acme)' } });
    fireEvent.submit(input);
    // capability + (quantity OR manufacturer) → three leaf conditions in the tree.
    expect(screen.getByTestId('count').textContent).toBe('3');
    expect(screen.queryByTestId('text-search-error')).toBeNull();
  });

  it('recalls a saved search into the builder', () => {
    useSavedSearchesStore.setState({
      searches: [{ id: '1', name: 'Two', query: 'cap:voltage>3.3 quantity<10' }],
    });
    renderWithBuilder();
    fireEvent.click(screen.getByTestId('saved-search-recall'));
    expect(screen.getByTestId('count').textContent).toBe('2');
  });
});
