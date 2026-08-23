import { describe, it, expect } from 'vitest';
import { IN_TRANSIT_LOCATION_ID, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { inventoryEmptyState } from './inventory-empty-state';

/**
 * The empty-state copy seam. The banner must describe *why* the list is empty from the
 * user's current viewpoint — a narrowed "no matches" view names the search/filters instead
 * of misleadingly inviting a first item.
 */
describe('inventoryEmptyState', () => {
  it('invites a first item for an empty, unfiltered inventory', () => {
    expect(inventoryEmptyState({})).toEqual({
      title: 'No items here yet',
      body: 'Add your first item to start tracking.',
    });
  });

  it('keeps the first-item invitation for an empty regular location', () => {
    const copy = inventoryEmptyState({ locationId: 'loc-1', locationName: 'Shed' });
    expect(copy.title).toBe('No items here yet');
    expect(copy.body).toMatch(/add your first item/i);
  });

  it('explains an empty system location rather than inviting a first item', () => {
    expect(inventoryEmptyState({ locationId: IN_TRANSIT_LOCATION_ID }).body).toMatch(/incoming stock waits/i);
    expect(inventoryEmptyState({ locationId: UNASSIGNED_LOCATION_ID }).body).toMatch(
      /don't have a location yet/i,
    );
  });

  it('names the search term when a search has no matches', () => {
    const copy = inventoryEmptyState({ search: 'widget' });
    expect(copy.title).toBe('No matching items');
    expect(copy.body).toContain('“widget”');
    expect(copy.body).not.toMatch(/add your first item/i);
  });

  it('points at the filters when a status filter has no matches', () => {
    const copy = inventoryEmptyState({ statusFilterCount: 2 });
    expect(copy.title).toBe('No matching items');
    expect(copy.body).toMatch(/match the selected filters/i);
  });

  it('counts category and tag facets as filters', () => {
    expect(inventoryEmptyState({ categoryFilter: true }).title).toBe('No matching items');
    expect(inventoryEmptyState({ tagFilterCount: 1 }).title).toBe('No matching items');
  });

  it('combines a search and filters in one sentence', () => {
    const copy = inventoryEmptyState({ search: 'bolt', statusFilterCount: 1 });
    expect(copy.body).toContain('“bolt”');
    expect(copy.body).toMatch(/and the selected filters/i);
  });

  it('scopes the narrowed message to the selected location', () => {
    const copy = inventoryEmptyState({
      statusFilterCount: 1,
      locationId: 'loc-1',
      locationName: 'Drawer A2',
    });
    expect(copy.body).toContain('in Drawer A2');
  });

  it('reports a visual search with no matches, superseding the quick filters', () => {
    const copy = inventoryEmptyState({ visualSearch: true, statusFilterCount: 3 });
    expect(copy.title).toBe('No matching items');
    expect(copy.body).toMatch(/visual search/i);
    expect(copy.body).not.toMatch(/selected filters/i);
  });

  it('names the location a visual search was scoped to (issue #626)', () => {
    const copy = inventoryEmptyState({
      visualSearch: true,
      visualSearchScoped: true,
      locationId: 'loc-1',
      locationName: 'Garage',
    });
    expect(copy.body).toContain('in Garage');
  });

  it('does not claim a location scope the visual search did not run under', () => {
    const copy = inventoryEmptyState({
      visualSearch: true,
      visualSearchScoped: false,
      locationId: 'loc-1',
      locationName: 'Garage',
    });
    expect(copy.body).not.toContain('Garage');
  });

  it('treats a blank/whitespace search as no narrowing', () => {
    expect(inventoryEmptyState({ search: '   ' }).title).toBe('No items here yet');
  });
});
