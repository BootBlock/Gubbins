/**
 * Event-view adapter tests (webhooks plan `W5`) over a hydrated SYNTHETIC snapshot.
 *
 * The view is the closed projection every `W3` module reads, so the properties worth pinning are
 * the ones those modules depend on: the location **path** (root-first, including the item's own
 * location) that makes subtree filtering a set test, and the rule that an absent fact is `null`
 * rather than invented — because `W3` narrows on "cannot confirm" rather than waving it through.
 */
import { describe, expect, it } from 'vitest';
import { hydrateFromJson } from '../hydrate.ts';
import { buildWebhookEventView, createWebhookViewContext } from './webhook-view.ts';
import type { BridgeEvent, LedgerEvent } from './model.ts';
import type { ItemSummaryDto } from '../api/dto.ts';

const NOW = 1_751_000_000_000;

/** A three-level location tree plus one item on the deepest shelf, with a category and a tag. */
function snapshot(): string {
  return JSON.stringify({
    formatVersion: 1,
    generatedAt: NOW,
    tables: {
      locations: [
        { id: 'loc-root', name: 'Workshop', parent_id: null, is_system: 0, updated_at: NOW },
        { id: 'loc-mid', name: 'Cabinet A', parent_id: 'loc-root', is_system: 0, updated_at: NOW },
        { id: 'loc-leaf', name: 'Shelf 2', parent_id: 'loc-mid', is_system: 0, updated_at: NOW },
      ],
      categories: [{ id: 'cat-1', name: 'Electronics', created_at: NOW, updated_at: NOW }],
      items: [
        {
          id: 'item-1',
          name: 'Widget',
          description: null,
          location_id: 'loc-leaf',
          category_id: 'cat-1',
          tracking_mode: 'DISCRETE',
          quantity: 7,
          reorder_point: 5,
          mpn: null,
          manufacturer: null,
          is_active: 1,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      item_stock: [
        {
          id: 'item-1|loc-leaf',
          item_id: 'item-1',
          location_id: 'loc-leaf',
          quantity: 7,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      item_history: [],
      tags: [{ id: 'tag-1', name: 'fragile', updated_at: NOW }],
    },
    // The M:N tag edges are timestamp-less membership rows and ride beside `tables`, not in it.
    itemTags: [{ itemId: 'item-1', tagId: 'tag-1' }],
  });
}

function summary(overrides: Partial<ItemSummaryDto> = {}): ItemSummaryDto {
  return {
    id: 'item-1',
    name: 'Widget',
    quantity: 7,
    locationId: 'loc-leaf',
    locationName: 'Shelf 2',
    categoryId: 'cat-1',
    mpn: null,
    manufacturer: null,
    trackingMode: 'DISCRETE',
    isActive: true,
    isUnlimited: false,
    ...overrides,
  };
}

function ledgerEvent(item: ItemSummaryDto | null): LedgerEvent {
  return {
    id: 'hist-1',
    type: 'stock.adjusted',
    occurredAt: '2025-06-27T06:13:20.000Z',
    data: {
      itemId: 'item-1',
      itemName: 'Widget',
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: 'Checked out 1.',
      delta: '−1',
      quantityDelta: -1,
      netValueDelta: null,
      actorUserId: 'user-ada',
      actorDisplayName: 'Ada',
      item,
    },
  };
}

async function context() {
  const { driver } = await hydrateFromJson(snapshot());
  return createWebhookViewContext(driver);
}

describe('buildWebhookEventView', () => {
  it('mirrors the envelope fields exactly, so a template echoing them matches the default payload', async () => {
    const view = await buildWebhookEventView(ledgerEvent(summary()), await context());
    expect(view.id).toBe('hist-1');
    expect(view.type).toBe('stock.adjusted');
    expect(view.occurredAt).toBe('2025-06-27T06:13:20.000Z');
  });

  it('projects the change from the ledger payload', async () => {
    const view = await buildWebhookEventView(ledgerEvent(summary()), await context());
    expect(view.change).toEqual({
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: 'Checked out 1.',
      delta: '−1',
      quantityDelta: -1,
      netValueDelta: null,
      actorUserId: 'user-ada',
      actorDisplayName: 'Ada',
    });
  });

  it('resolves the location path root-first, INCLUDING the item’s own location', async () => {
    // This exact shape is what makes a subtree filter a pure `includes` in the evaluator.
    const view = await buildWebhookEventView(ledgerEvent(summary()), await context());
    expect(view.item?.locationPath).toEqual(['loc-root', 'loc-mid', 'loc-leaf']);
  });

  it('resolves the category name and the tag ids the filter vocabulary needs', async () => {
    const view = await buildWebhookEventView(ledgerEvent(summary()), await context());
    expect(view.item?.categoryName).toBe('Electronics');
    expect(view.item?.tagIds).toEqual(['tag-1']);
  });

  it('reuses one context across events without re-resolving (the per-generation cache)', async () => {
    const ctx = await context();
    await buildWebhookEventView(ledgerEvent(summary()), ctx);
    expect(ctx.locationPaths.get('loc-leaf')).toEqual(['loc-root', 'loc-mid', 'loc-leaf']);
    expect(ctx.categoryNames.get('cat-1')).toBe('Electronics');

    const second = await buildWebhookEventView(ledgerEvent(summary()), ctx);
    expect(second.item?.locationPath).toEqual(['loc-root', 'loc-mid', 'loc-leaf']);
  });

  it('gives an unknown location a self-only path rather than throwing', async () => {
    const view = await buildWebhookEventView(
      ledgerEvent(summary({ locationId: 'loc-nope', locationName: null })),
      await context(),
    );
    // The chain stops as soon as a level cannot be read, but the item's OWN location id is always
    // in it — so a subtree filter naming that location still matches, while one naming an ancestor
    // we could not confirm does not. Narrowing on an unconfirmable fact is the safe direction.
    expect(view.item?.locationPath).toEqual(['loc-nope']);
  });

  it('gives an unknown category a null name rather than throwing', async () => {
    const view = await buildWebhookEventView(
      ledgerEvent(summary({ categoryId: 'cat-nope' })),
      await context(),
    );
    expect(view.item?.categoryName).toBeNull();
  });

  it('projects item: null for a ledger event whose item could not be read', async () => {
    const view = await buildWebhookEventView(ledgerEvent(null), await context());
    expect(view.item).toBeNull();
    // The change is real and still worth delivering even though the item is gone.
    expect(view.change?.action).toBe('QUANTITY_CHANGE');
  });

  it('projects both item and change as null for the read-triggered lookup event', async () => {
    const lookup: BridgeEvent = {
      id: 'lookup:abc:0',
      type: 'lookup.resolved',
      occurredAt: '2025-06-27T06:13:20.000Z',
      data: { query: 'widget', itemIds: ['item-1'], locationIds: ['loc-leaf'], matches: [] },
    };
    const view = await buildWebhookEventView(lookup, await context());
    // Deliberately NOT "the first match is the item": that would let an item-scoped filter match
    // on a coincidence of what somebody happened to search for.
    expect(view.item).toBeNull();
    expect(view.change).toBeNull();
    expect(view.type).toBe('lookup.resolved');
  });

  it('degrades the three resolved facts when no context is supplied', async () => {
    const view = await buildWebhookEventView(ledgerEvent(summary()));
    expect(view.item).toMatchObject({
      id: 'item-1',
      name: 'Widget',
      quantity: 7,
      locationId: 'loc-leaf',
      locationName: 'Shelf 2',
      categoryId: 'cat-1',
      // Resolved facts need a driver; without one they take their absent values.
      locationPath: [],
      categoryName: null,
      tagIds: [],
    });
  });
});
