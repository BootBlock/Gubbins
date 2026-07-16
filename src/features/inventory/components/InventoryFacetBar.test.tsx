import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { InventoryFacetBar } from './InventoryFacetBar';

// Mutable category / tag dictionaries so each test can shape what the facets have to offer.
// `inUse` is the id set the item-scoped `useCategoriesInUse` reports; `undefined` models the
// pre-resolution state where the facet should show every category.
const { catRows, tagRows, inUse } = vi.hoisted(() => ({
  catRows: { current: [] as { id: string; name: string }[] },
  tagRows: { current: [] as { id: string; name: string }[] },
  inUse: { current: undefined as string[] | undefined },
}));
vi.mock('../categories', () => ({
  useCategories: () => ({ data: { rows: catRows.current } }),
  useCategoriesInUse: () => ({ data: inUse.current }),
}));
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
    // Both categories in use by default, so the existing selection assertions still hold.
    inUse.current = ['cat-1', 'cat-2'];
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
        locationId={overrides.locationId ?? null}
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

  it('excludes an already-active tag from the adder options (memoized on tagIds)', () => {
    renderBar({ tagIds: ['tag-1'] });
    fireEvent.click(screen.getByTestId('inventory-facet-tag-add'));
    // The active tag is filtered out of the "add a tag" list; the other stays selectable.
    expect(screen.queryByRole('option', { name: 'fragile' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'electronics' })).toBeInTheDocument();
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

  it('offers only categories in use, not the whole catalogue (issue #76)', () => {
    // Both categories exist, but only Resistors has an item in the current view.
    inUse.current = ['cat-1'];
    renderBar();
    fireEvent.click(screen.getByTestId('inventory-facet-category'));
    expect(screen.getByRole('option', { name: 'Resistors' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tools' })).not.toBeInTheDocument();
  });

  it('keeps the currently-selected category even when it is no longer in use', () => {
    // Tools is filtered on but its last item just moved away — it must stay offered so the
    // active filter can be switched off, while an unused-and-unselected category stays hidden.
    inUse.current = [];
    renderBar({ categoryId: 'cat-2' });
    fireEvent.click(screen.getByTestId('inventory-facet-category'));
    expect(screen.getByRole('option', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Resistors' })).not.toBeInTheDocument();
  });

  it('hides the category facet entirely when no category is in use and none is selected', () => {
    inUse.current = [];
    tagRows.current = []; // also drop the tags facet so the whole bar can collapse
    renderBar();
    expect(screen.queryByTestId('inventory-facet-category')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inventory-facet-bar')).not.toBeInTheDocument();
  });

  it('shows every category until the in-use set has resolved (no empty flash)', () => {
    // Before the item-scoped query resolves, data is undefined — show all rather than flash empty.
    inUse.current = undefined;
    renderBar();
    fireEvent.click(screen.getByTestId('inventory-facet-category'));
    expect(screen.getByRole('option', { name: 'Resistors' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Tools' })).toBeInTheDocument();
  });
});
