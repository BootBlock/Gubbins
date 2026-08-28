/**
 * Tests for the Inventory screen's URL view state (issue #574) — `view-params.ts`.
 *
 * Three things earn a test here. A URL is untrusted input, so `parseInventorySearch` has to make
 * sense of anything a hand-edited or stale link carries without throwing. A view has to survive
 * the round trip through a URL unchanged, or a bookmark quietly means something else when it is
 * reopened. And a filter change has to reset the page, which is the rule that stops a narrowing
 * filter stranding the user on a page that no longer exists.
 */
import { describe, it, expect } from 'vitest';
import { ITEM_STATUS_FILTERS } from '@/db/repositories';
import {
  applyInventoryViewPatch,
  decodeInventoryView,
  encodeInventoryView,
  parseInventorySearch,
  DEFAULT_INVENTORY_VIEW,
  type InventoryView,
} from './view-params';

describe('parseInventorySearch — an untrusted URL', () => {
  it('keeps the params it recognises', () => {
    expect(
      parseInventorySearch({
        loc: 'loc-1',
        q: 'resistor',
        status: 'low-stock,expiring',
        cat: 'cat-1',
        tags: 'tag-b,tag-a',
        removed: true,
        page: 3,
      }),
    ).toEqual({
      loc: 'loc-1',
      q: 'resistor',
      status: 'low-stock,expiring',
      cat: 'cat-1',
      tags: 'tag-a,tag-b',
      removed: true,
      page: 3,
    });
  });

  it('drops an unknown status token rather than passing it to the query', () => {
    expect(parseInventorySearch({ status: 'low-stock,not-a-status' }).status).toBe('low-stock');
    expect(parseInventorySearch({ status: 'nonsense' }).status).toBeUndefined();
  });

  it('normalises both lists, so two URLs meaning one view are written alike', () => {
    // Statuses come back in ITEM_STATUS_FILTERS order however they were typed; tags sorted.
    expect(parseInventorySearch({ status: 'expiring,low-stock' }).status).toBe('low-stock,expiring');
    expect(parseInventorySearch({ tags: 'c,a,b,a' }).tags).toBe('a,b,c');
    expect(parseInventorySearch({ tags: ' a , , b ' }).tags).toBe('a,b');
  });

  it('refuses a page that is not a number above 1', () => {
    for (const page of ['nonsense', 0, -4, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseInventorySearch({ page }).page).toBeUndefined();
    }
    expect(parseInventorySearch({ page: '4' }).page).toBe(4);
    expect(parseInventorySearch({ page: 4.7 }).page).toBe(4);
  });

  it('treats anything but a true "removed" as off', () => {
    expect(parseInventorySearch({ removed: true }).removed).toBe(true);
    expect(parseInventorySearch({ removed: 'true' }).removed).toBe(true);
    expect(parseInventorySearch({ removed: 'maybe' }).removed).toBeUndefined();
    expect(parseInventorySearch({ removed: 1 }).removed).toBeUndefined();
  });

  it('shows the default view for an empty or junk query string', () => {
    expect(parseInventorySearch({})).toEqual({});
    expect(decodeInventoryView(parseInventorySearch({ nonsense: 'x', q: '   ' }))).toEqual(
      DEFAULT_INVENTORY_VIEW,
    );
  });
});

describe('encode ↔ decode — a bookmarked view reopens as itself', () => {
  const view: InventoryView = {
    locationId: 'loc-1',
    search: 'brass widget',
    statuses: ['low-stock', 'expiring'],
    categoryId: 'cat-1',
    tagIds: ['tag-a', 'tag-b'],
    includeInactive: true,
    page: 4,
  };

  it('survives the round trip through the URL', () => {
    expect(decodeInventoryView(parseInventorySearch({ ...encodeInventoryView(view) }))).toEqual(view);
  });

  it('writes nothing for a view at its defaults, so /inventory stays clean', () => {
    expect(encodeInventoryView(DEFAULT_INVENTORY_VIEW)).toEqual({});
  });

  it('drops an axis from the URL when it returns to its default', () => {
    const narrowed = encodeInventoryView(view);
    expect(narrowed.loc).toBe('loc-1');
    const widened = encodeInventoryView({ ...view, locationId: null, page: 1, includeInactive: false });
    expect(widened).not.toHaveProperty('loc');
    expect(widened).not.toHaveProperty('page');
    expect(widened).not.toHaveProperty('removed');
  });

  it('orders the statuses canonically however they were toggled, so the query key is stable', () => {
    const [first, second] = ITEM_STATUS_FILTERS;
    const forwards = encodeInventoryView({ ...DEFAULT_INVENTORY_VIEW, statuses: [first!, second!] });
    const backwards = encodeInventoryView({ ...DEFAULT_INVENTORY_VIEW, statuses: [second!, first!] });
    expect(forwards.status).toBe(`${first},${second}`);
    expect(backwards).toEqual(forwards);
  });
});

describe('applyInventoryViewPatch', () => {
  const paged: InventoryView = { ...DEFAULT_INVENTORY_VIEW, page: 7 };

  it('resets the page when a filter changes', () => {
    expect(applyInventoryViewPatch(paged, { locationId: 'loc-2' }).page).toBe(1);
    expect(applyInventoryViewPatch(paged, { search: 'drill' }).page).toBe(1);
    expect(applyInventoryViewPatch(paged, { statuses: ['low-stock'] }).page).toBe(1);
    expect(applyInventoryViewPatch(paged, { tagIds: ['tag-a'] }).page).toBe(1);
    expect(applyInventoryViewPatch(paged, { categoryId: 'cat-1' }).page).toBe(1);
    expect(applyInventoryViewPatch(paged, { includeInactive: true }).page).toBe(1);
  });

  it('keeps every filter when only the page turns', () => {
    const filtered: InventoryView = { ...paged, locationId: 'loc-2', search: 'drill' };
    expect(applyInventoryViewPatch(filtered, { page: 2 })).toEqual({ ...filtered, page: 2 });
  });

  it('lets a patch name the page it wants alongside a filter change', () => {
    expect(applyInventoryViewPatch(paged, { locationId: 'loc-2', page: 5 }).page).toBe(5);
  });
});
