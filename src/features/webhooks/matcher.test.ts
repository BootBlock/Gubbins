/**
 * Tests for subscription matching (webhooks plan `W3`, §7) — the three gates: enabled, event
 * type, filter.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_EVENT_TYPES } from '@/features/events/event-types';
import type { WebhookEventView } from './event-view';
import type { WebhookFilter } from './filter';
import {
  eventTypeMatches,
  matchingSubscriptions,
  subscriptionMatches,
  type WebhookMatchTarget,
} from './matcher';
import { WEBHOOK_ALL_EVENTS } from './subscription';

function view(type = 'item.created'): WebhookEventView {
  return {
    id: 'hist-1',
    type,
    occurredAt: '2026-07-18T10:00:00.000Z',
    item: {
      id: 'item-1',
      name: 'M3 screws',
      quantity: 4,
      locationId: 'loc-drawer',
      locationName: 'Drawer 2',
      locationPath: ['loc-workshop', 'loc-drawer'],
      categoryId: 'cat-fasteners',
      categoryName: 'Fasteners',
      tagIds: ['tag-metric'],
    },
    change: null,
  };
}

function target(overrides: Partial<WebhookMatchTarget> = {}): WebhookMatchTarget {
  return { enabled: true, eventTypes: ['item.created'], filter: null, ...overrides };
}

describe('eventTypeMatches', () => {
  it('matches a named type exactly', () => {
    expect(eventTypeMatches(['item.created', 'item.moved'], 'item.moved')).toBe(true);
    expect(eventTypeMatches(['item.created'], 'item.moved')).toBe(false);
  });

  it('matches every known type through the wildcard', () => {
    for (const type of KNOWN_EVENT_TYPES) {
      expect(eventTypeMatches([WEBHOOK_ALL_EVENTS], type)).toBe(true);
    }
  });

  it('matches nothing for an empty list, which is what a corrupt synced row softens to', () => {
    expect(eventTypeMatches([], 'item.created')).toBe(false);
  });

  it('does not support prefix globs — the wildcard is all-or-named', () => {
    // Deliberate: a glob would silently widen as new dotted types are added.
    expect(eventTypeMatches(['item.*'], 'item.created')).toBe(false);
    expect(eventTypeMatches(['item.'], 'item.created')).toBe(false);
  });

  it('is exact about case and whitespace', () => {
    expect(eventTypeMatches(['Item.Created'], 'item.created')).toBe(false);
    expect(eventTypeMatches([' item.created'], 'item.created')).toBe(false);
  });
});

describe('subscriptionMatches', () => {
  it('matches when the type is subscribed and there is no filter', () => {
    expect(subscriptionMatches(target(), view())).toBe(true);
  });

  it('never matches a disabled subscription, whatever its types say', () => {
    expect(subscriptionMatches(target({ enabled: false }), view())).toBe(false);
    expect(subscriptionMatches(target({ enabled: false, eventTypes: [WEBHOOK_ALL_EVENTS] }), view())).toBe(
      false,
    );
  });

  it('rejects an unsubscribed type before consulting the filter', () => {
    expect(subscriptionMatches(target({ eventTypes: ['item.moved'] }), view('item.created'))).toBe(false);
  });

  it('applies the filter once the type has passed', () => {
    const inDrawer: WebhookFilter = { kind: 'location', locationIds: ['loc-drawer'] };
    const elsewhere: WebhookFilter = { kind: 'location', locationIds: ['loc-attic'] };
    expect(subscriptionMatches(target({ filter: inDrawer }), view())).toBe(true);
    expect(subscriptionMatches(target({ filter: elsewhere }), view())).toBe(false);
  });

  it('combines the wildcard with a filter', () => {
    const lowStock: WebhookFilter = { kind: 'quantity', op: 'lt', value: 5 };
    expect(
      subscriptionMatches(target({ eventTypes: [WEBHOOK_ALL_EVENTS], filter: lowStock }), view('item.moved')),
    ).toBe(true);
  });
});

describe('matchingSubscriptions', () => {
  it('returns only the matching targets, in the caller order', () => {
    const first = { ...target(), id: 'a' };
    const disabled = { ...target({ enabled: false }), id: 'b' };
    const wildcard = { ...target({ eventTypes: [WEBHOOK_ALL_EVENTS] }), id: 'c' };
    const other = { ...target({ eventTypes: ['item.moved'] }), id: 'd' };

    expect(matchingSubscriptions([first, disabled, wildcard, other], view()).map((t) => t.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('returns nothing rather than throwing when there are no targets', () => {
    expect(matchingSubscriptions([], view())).toEqual([]);
  });
});
