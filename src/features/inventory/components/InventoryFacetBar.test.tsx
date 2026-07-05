import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { InventoryFacetBar } from './InventoryFacetBar';

// Mutable category / tag dictionaries so each test can shape what the facets have to offer.
const { catRows, tagRows } = vi.hoisted(() => ({
  catRows: { current: [] as { id: string; name: string }[] },
  tagRows: { current: [] as { id: string; name: string }[] },
}));
vi.mock('../categories', () => ({ useCategories: () => ({ data: { rows: catRows.current } }) }));
vi.mock('../tags', () => ({ useTagDictionary: () => ({ data: { rows: tagRows.current } }) }));

/**
 * The inventory facet bar: a Category single-select and a Tags token-multiselect, each gated
 * on data availability (and the Tags facet on the `tags-attachments` capability). The Foundry
 * Select is a custom listbox, so a choice is a click-open + click-option (per
 * [[foundry-select-combobox]]).
 */
describe('InventoryFacetBar', () => {
  beforeEach(() => {
    useModulesStore.setState({ intent: {} }); // tags-attachments on by default
    catRows.current = [
      { id: 'cat-1', name: 'Resistors' },
      { id: 'cat-2', name: 'Tools' },
    ];
    tagRows.current = [
      { id: 'tag-1', name: 'fragile' },
      { id: 'tag-2', name: 'electronics' },
    ];
  });
  afterEach(() => {
    cleanup();
    useModulesStore.setState({ intent: {} });
  });

  function renderBar(overrides: Partial<Parameters<typeof InventoryFacetBar>[0]> = {}) {
    const onCategoryChange = vi.fn();
    const onToggleTag = vi.fn();
    render(
      <InventoryFacetBar
        categoryId={overrides.categoryId ?? null}
        onCategoryChange={onCategoryChange}
        tagIds={overrides.tagIds ?? []}
        onToggleTag={onToggleTag}
        disabled={overrides.disabled}
      />,
    );
    return { onCategoryChange, onToggleTag };
  }

  it('renders the category select and the tag adder when both have data', () => {
    renderBar();
    expect(screen.getByTestId('inventory-facet-category')).toBeInTheDocument();
    expect(screen.getByTestId('inventory-facet-tag-add')).toBeInTheDocument();
  });

  it('reports a chosen category', () => {
    const { onCategoryChange } = renderBar();
    fireEvent.click(screen.getByTestId('inventory-facet-category'));
    fireEvent.click(screen.getByRole('option', { name: 'Tools' }));
    expect(onCategoryChange).toHaveBeenCalledWith('cat-2');
  });

  it('maps the "All categories" option back to null', () => {
    const { onCategoryChange } = renderBar({ categoryId: 'cat-1' });
    fireEvent.click(screen.getByTestId('inventory-facet-category'));
    fireEvent.click(screen.getByRole('option', { name: 'All categories' }));
    expect(onCategoryChange).toHaveBeenCalledWith(null);
  });

  it('adds a tag when one is picked from the adder', () => {
    const { onToggleTag } = renderBar();
    fireEvent.click(screen.getByTestId('inventory-facet-tag-add'));
    fireEvent.click(screen.getByRole('option', { name: 'electronics' }));
    expect(onToggleTag).toHaveBeenCalledWith('tag-2');
  });

  it('renders a removable chip per active tag and removes on click', () => {
    const { onToggleTag } = renderBar({ tagIds: ['tag-1'] });
    const chip = screen.getByTestId('inventory-facet-tag-chip-tag-1');
    expect(chip).toHaveTextContent('fragile');
    fireEvent.click(chip);
    expect(onToggleTag).toHaveBeenCalledWith('tag-1');
  });

  it('hides the tag facet when tags-attachments is off, keeping the category select', () => {
    useModulesStore.getState().setFeatureIntent('tags-attachments', false);
    renderBar();
    expect(screen.queryByTestId('inventory-facet-tag-add')).not.toBeInTheDocument();
    expect(screen.getByTestId('inventory-facet-category')).toBeInTheDocument();
  });

  it('renders nothing when there are no categories and no tags to offer', () => {
    catRows.current = [];
    tagRows.current = [];
    renderBar();
    expect(screen.queryByTestId('inventory-facet-bar')).not.toBeInTheDocument();
  });
});
