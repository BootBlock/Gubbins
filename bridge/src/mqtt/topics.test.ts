/**
 * MQTT topic + payload construction tests (EI-5) — pure, no broker or DB.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeKey,
  DEFAULT_TOPIC_PREFIX,
  eventPayload,
  locatePayload,
  locationAttributes,
  locationPayload,
  sanitizeTopicLevel,
  summaryPayload,
  topicsFor,
} from './topics.ts';
import type { InventoryState } from './state.ts';
import type { BridgeEvent } from '../events/model.ts';
import { LOOKUP_RESOLVED_TYPE, type LookupEvent } from '../events/lookup.ts';

const STATE: InventoryState = {
  itemsTotal: 3,
  lowStockItems: 2,
  outOfStockItems: 1,
  locations: [
    {
      id: 'loc-store',
      name: 'Store Room',
      itemCount: 2,
      fieldValues: [
        { name: 'HA Entity', fieldType: 'TEXT', value: 'light.store_room', isInheritable: true },
        { name: 'Aisle', fieldType: 'TEXT', value: 'B', isInheritable: false },
      ],
    },
    { id: 'loc-bench', name: 'Workbench', itemCount: 1, fieldValues: [] },
  ],
  generatedAt: '2025-06-27T07:33:20.000Z',
};

const LOOKUP: LookupEvent = {
  id: 'lookup:abc0123456789def:1751000000000',
  type: LOOKUP_RESOLVED_TYPE,
  occurredAt: '2025-06-27T07:33:20.000Z',
  data: {
    query: 'solder',
    itemIds: ['item-solder'],
    locationIds: ['loc-store'],
    matches: [
      {
        itemId: 'item-solder',
        itemName: 'Solder 0.7mm',
        placements: [{ locationId: 'loc-store', locationName: 'Store Room', quantity: 3 }],
      },
    ],
  },
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
    expect(t.locate).toBe('gubbins/locate');
  });
  it('honours a custom prefix and defaults a blank one', () => {
    expect(topicsFor('home/gubbins').summaryState).toBe('home/gubbins/summary/state');
    expect(topicsFor('').base).toBe('gubbins');
  });
  it('sanitises a wildcard-bearing id in a templated topic', () => {
    expect(topicsFor('gubbins').locationState('a/b')).toBe('gubbins/location/a_b/state');
  });
});

describe('attributeKey', () => {
  it('slugifies a dictionary name into a template-friendly key', () => {
    expect(attributeKey('HA Entity')).toBe('ha_entity');
    expect(attributeKey('Shelf/Bin #')).toBe('shelf_bin');
  });
  it('keeps a leading-digit or empty name usable', () => {
    expect(attributeKey('3D Printer')).toBe('field_3d_printer');
    expect(attributeKey('///')).toBe('field');
  });
});

describe('locationAttributes', () => {
  it('keeps the first of two names that normalise to the same key', () => {
    const attributes = locationAttributes({
      id: 'loc-x',
      name: 'Bay',
      itemCount: 0,
      fieldValues: [
        { name: 'HA Entity', fieldType: 'TEXT', value: 'light.first', isInheritable: false },
        { name: 'ha entity', fieldType: 'TEXT', value: 'light.second', isInheritable: false },
      ],
    });
    expect(attributes).toEqual({ ha_entity: 'light.first' });
  });

  it('publishes a field whose key collides with an Object.prototype member', () => {
    // `'constructor' in {}` is true on a prototype-bearing object, so a naive collision guard
    // would silently drop this field rather than publish it.
    const attributes = locationAttributes({
      id: 'loc-x',
      name: 'Bay',
      itemCount: 0,
      fieldValues: [
        { name: 'Constructor', fieldType: 'TEXT', value: 'Aisle Fabrications', isInheritable: false },
        { name: 'HA Entity', fieldType: 'TEXT', value: 'light.bay', isInheritable: false },
      ],
    });
    expect(attributes.constructor).toBe('Aisle Fabrications');
    expect(attributes.ha_entity).toBe('light.bay');
    // And it survives serialisation onto the wire, which is what HA actually reads.
    expect(JSON.parse(JSON.stringify(attributes)).constructor).toBe('Aisle Fabrications');
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
  it('location carries id/name/itemCount plus its custom fields as attributes', () => {
    expect(JSON.parse(locationPayload(STATE.locations[0]!))).toEqual({
      id: 'loc-store',
      name: 'Store Room',
      itemCount: 2,
      attributes: { ha_entity: 'light.store_room', aisle: 'B' },
    });
  });

  it('gives a location with no custom fields an EMPTY attributes object, never a missing key', () => {
    expect(JSON.parse(locationPayload(STATE.locations[1]!))).toEqual({
      id: 'loc-bench',
      name: 'Workbench',
      itemCount: 1,
      attributes: {},
    });
  });

  it('locate flattens the lookup answer to the top level', () => {
    expect(JSON.parse(locatePayload(LOOKUP))).toEqual({
      id: LOOKUP.id,
      occurredAt: LOOKUP.occurredAt,
      query: 'solder',
      itemIds: ['item-solder'],
      locationIds: ['loc-store'],
      matches: [
        {
          itemId: 'item-solder',
          itemName: 'Solder 0.7mm',
          placements: [{ locationId: 'loc-store', locationName: 'Store Room', quantity: 3 }],
        },
      ],
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
