/**
 * MQTT topic + payload construction tests (EI-5) — pure, no broker or DB.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPIC_PREFIX,
  eventPayload,
  locationPayload,
  sanitizeTopicLevel,
  summaryPayload,
  topicsFor,
} from './topics.ts';
import type { InventoryState } from './state.ts';
import type { BridgeEvent } from '../events/model.ts';

const STATE: InventoryState = {
  itemsTotal: 3,
  lowStockItems: 2,
  outOfStockItems: 1,
  locations: [
    { id: 'loc-store', name: 'Store Room', itemCount: 2 },
    { id: 'loc-bench', name: 'Workbench', itemCount: 1 },
  ],
  generatedAt: '2025-06-27T07:33:20.000Z',
};

describe('sanitizeTopicLevel', () => {
  it('replaces the separator and both wildcards', () => {
    expect(sanitizeTopicLevel('a/b+c#d')).toBe('a_b_c_d');
  });
  it('leaves a normal record id untouched', () => {
    expect(sanitizeTopicLevel('item-esp32_01')).toBe('item-esp32_01');
  });
  it('never yields an empty level', () => {
    expect(sanitizeTopicLevel('#')).toBe('_');
  });
});

describe('topicsFor', () => {
  it('hangs everything under the default prefix', () => {
    const t = topicsFor(DEFAULT_TOPIC_PREFIX);
    expect(t.status).toBe('gubbins/status');
    expect(t.summaryState).toBe('gubbins/summary/state');
    expect(t.locationState('loc-store')).toBe('gubbins/location/loc-store/state');
    expect(t.event('item.low_stock')).toBe('gubbins/event/item.low_stock');
  });
  it('honours a custom prefix and defaults a blank one', () => {
    expect(topicsFor('home/gubbins').summaryState).toBe('home/gubbins/summary/state');
    expect(topicsFor('').base).toBe('gubbins');
  });
  it('sanitises a wildcard-bearing id in a templated topic', () => {
    expect(topicsFor('gubbins').locationState('a/b')).toBe('gubbins/location/a_b/state');
  });
});

describe('payloads', () => {
  it('summary carries the four counts + locationsTotal + generatedAt', () => {
    expect(JSON.parse(summaryPayload(STATE))).toEqual({
      itemsTotal: 3,
      lowStockItems: 2,
      outOfStockItems: 1,
      locationsTotal: 2,
      generatedAt: '2025-06-27T07:33:20.000Z',
    });
  });
  it('location carries id/name/itemCount', () => {
    expect(JSON.parse(locationPayload(STATE.locations[0]!))).toEqual({
      id: 'loc-store',
      name: 'Store Room',
      itemCount: 2,
    });
  });
  it('event is the BridgeEvent verbatim', () => {
    const event = {
      id: 'e1',
      type: 'item.created',
      occurredAt: 'x',
      data: { itemId: 'i1' },
    } as unknown as BridgeEvent;
    expect(JSON.parse(eventPayload(event))).toMatchObject({ id: 'e1', type: 'item.created' });
  });
});
