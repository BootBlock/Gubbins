/**
 * Pure feed-model tests (EI-6) — the ActivityFeedEntry → FeedItem mapping, reusing the app's
 * history/activity-kind seams. No DB: entries are constructed inline.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityFeedEntry } from '@/db/repositories/types';
import { toFeedItem } from './feed-model.ts';

function entry(overrides: Partial<ActivityFeedEntry> = {}): ActivityFeedEntry {
  return {
    id: 'hist-1',
    itemId: 'item-1',
    itemName: 'Widget',
    itemIsActive: true,
    action: 'QUANTITY_CHANGE',
    quantityDelta: -3,
    netValueDelta: null,
    note: 'Checked out 3.',
    metadata: null,
    actorUserId: 'user-ada',
    actorDisplayName: 'Ada',
    createdAt: 1_751_000_000_000,
    ...overrides,
  };
}

describe('toFeedItem', () => {
  it('maps a stock change to the stable dotted type, stock kind and a note summary', () => {
    const item = toFeedItem(entry());
    expect(item).toEqual({
      id: 'hist-1',
      type: 'stock.adjusted',
      kind: 'stock',
      title: 'Widget — Quantity changed',
      summary: 'Checked out 3.',
      itemId: 'item-1',
      itemName: 'Widget',
      itemActive: true,
      occurredAt: 1_751_000_000_000,
    });
  });

  it('falls back to the action label when the entry has no note', () => {
    const item = toFeedItem(entry({ action: 'MOVED', note: null, quantityDelta: null }));
    expect(item.type).toBe('item.moved');
    expect(item.kind).toBe('movement');
    expect(item.title).toBe('Widget — Moved');
    expect(item.summary).toBe('Moved');
  });

  it('carries a soft-deleted item through with itemActive false', () => {
    const item = toFeedItem(entry({ action: 'SOFT_DELETED', itemIsActive: false, note: 'Removed.' }));
    expect(item.itemActive).toBe(false);
    expect(item.type).toBe('item.removed');
    expect(item.kind).toBe('lifecycle');
  });

  it('degrades an unknown (forward-compat) action to item.changed / lifecycle', () => {
    const item = toFeedItem(entry({ action: 'SOME_FUTURE_ACTION' as never, note: null }));
    expect(item.type).toBe('item.changed');
    expect(item.kind).toBe('lifecycle');
  });
});
