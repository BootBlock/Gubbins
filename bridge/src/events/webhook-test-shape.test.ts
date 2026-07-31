/**
 * The synthetic test event's **shape** follows the subscribed type (issue #691).
 *
 * The whole value of "Send test event" is that it is the real path with only the event synthesised.
 * A location-only subscription tested with an item-shaped payload would greenlight a receiver that
 * cannot read the events it will actually get — so the one thing worth pinning here is that the
 * payload a subscriber is handed matches the payload its real events will carry.
 */
import { describe, expect, it } from 'vitest';
import { buildWebhookTestEvent, TEST_EVENT_ITEM_ID, TEST_EVENT_LOCATION_ID } from './webhook-test.ts';
import { isLocationEvent } from './model.ts';

const at = 1_700_000_000_000;

describe('buildWebhookTestEvent shape', () => {
  it('builds a location-shaped payload for a location-only subscription', () => {
    const event = buildWebhookTestEvent(['location.moved'], { id: 'test:1', at });

    expect(event.type).toBe('location.moved');
    expect(isLocationEvent(event)).toBe(true);
    expect(event.data).toMatchObject({
      locationId: TEST_EVENT_LOCATION_ID,
      locationName: 'Gubbins test event',
      action: 'RE_PARENTED',
      label: 'Moved',
    });
  });

  it('builds a location-shaped payload for the generic location fallback type', () => {
    // `location.changed` is reachable but has no action mapping *to* it, so it must still resolve
    // to a location payload rather than dropping through to the item branch.
    const event = buildWebhookTestEvent(['location.changed'], { id: 'test:2', at });
    expect(isLocationEvent(event)).toBe(true);
  });

  it('still builds an item-shaped payload for an item subscription', () => {
    const event = buildWebhookTestEvent(['stock.adjusted'], { id: 'test:3', at });

    expect(isLocationEvent(event)).toBe(false);
    expect(event.data).toMatchObject({ itemId: TEST_EVENT_ITEM_ID, item: null });
  });

  it('falls back to the item shape for a wildcard subscription', () => {
    const event = buildWebhookTestEvent(['*'], { id: 'test:4', at });

    expect(event.type).toBe('item.changed');
    expect(isLocationEvent(event)).toBe(false);
  });
});
