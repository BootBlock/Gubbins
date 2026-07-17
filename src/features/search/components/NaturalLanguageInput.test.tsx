import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SearchBuilderProvider, useSearchBuilder } from '../SearchBuilderContext';
import { NaturalLanguageInput } from './NaturalLanguageInput';

// The two resolver hooks are DB-backed; mock them to plain rows so the pure seam gets its
// location/category names without a worker. usePreferencesStore is a real store (its default
// low-stock threshold is 0, so "low stock" exercises the NL fallback floor).
vi.mock('@/features/inventory/queries', () => ({
  useLocations: () => ({ data: { rows: [{ id: 'loc-garage', name: 'Garage' }] } }),
}));
vi.mock('@/features/inventory/categories', () => ({
  useCategories: () => ({ data: { rows: [{ id: 'cat-res', name: 'Resistors' }] } }),
}));

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

/** A probe exposing the live AST condition count + the first two fields, for assertions. */
function Probe() {
  const { ast, conditionCount } = useSearchBuilder();
  const fields = ast.conditions.map((c) => ('field' in c ? c.field : 'group')).join(',');
  return (
    <>
      <output data-testid="count">{conditionCount}</output>
      <output data-testid="fields">{fields}</output>
    </>
  );
}

function renderWithBuilder() {
  return render(
    <SearchBuilderProvider>
      <NaturalLanguageInput />
      <Probe />
    </SearchBuilderProvider>,
  );
}

describe('NaturalLanguageInput — plain-English → builder (G5)', () => {
  it('interprets the headline phrase and fills the builder AST', () => {
    renderWithBuilder();
    const input = screen.getByTestId('nl-search-input');
    fireEvent.change(input, { target: { value: 'low stock screws in the garage' } });
    fireEvent.submit(input);
    // Three root nodes — quantity < N, location = garage, then the residual multi-field text
    // match (a sub-tree, so the probe reports it as "group").
    expect(screen.getByTestId('fields').textContent).toBe('quantity,location,group');
    // conditionCount is a deep *leaf* count: quantity + location + the three field leaves the
    // "screw" text match fans out to (name/description/manufacturer) = 5.
    expect(screen.getByTestId('count').textContent).toBe('5');
  });

  it('echoes what was understood', () => {
    renderWithBuilder();
    const input = screen.getByTestId('nl-search-input');
    fireEvent.change(input, { target: { value: 'out of stock resistors' } });
    fireEvent.submit(input);
    expect(screen.getByText('Out of stock')).toBeTruthy();
    expect(screen.getByText('Category: Resistors')).toBeTruthy();
  });

  it('shows a gentle miss and leaves the builder untouched when nothing matches', () => {
    renderWithBuilder();
    const input = screen.getByTestId('nl-search-input');
    fireEvent.change(input, { target: { value: 'show me all the items please' } });
    fireEvent.submit(input);
    expect(screen.getByTestId('nl-search-miss')).toBeTruthy();
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('clears a prior miss once the user edits the phrase', () => {
    renderWithBuilder();
    const input = screen.getByTestId('nl-search-input');
    fireEvent.change(input, { target: { value: 'show me all my items' } });
    fireEvent.submit(input);
    expect(screen.queryByTestId('nl-search-miss')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'in stock' } });
    expect(screen.queryByTestId('nl-search-miss')).toBeNull();
  });
});
