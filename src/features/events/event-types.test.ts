/**
 * Guards the shared dotted event-type vocabulary (webhooks plan `W0`).
 *
 * These names are a public contract — they reach bridge webhook payloads, the SSE stream, the MQTT
 * topics and the OpenAPI enum — so the tests here are deliberately about *stability* rather than
 * implementation: every ledger action maps to something, the fallback holds, and the catalogue the
 * subscription picker will be built from covers everything the system can actually emit.
 */
import { describe, expect, it } from 'vitest';
import { HISTORY_ACTIONS } from '@/db/repositories/constants';
import {
  ACTION_EVENT_TYPE,
  EVENTS_TRUNCATED_TYPE,
  eventTypeForAction,
  ITEM_CHANGED_TYPE,
  KNOWN_EVENT_TYPES,
  LOOKUP_RESOLVED_TYPE,
  LOW_STOCK_TYPE,
  OUT_OF_STOCK_TYPE,
} from './event-types';

describe('event-types', () => {
  it('maps every ledger action to a dotted event type', () => {
    for (const action of HISTORY_ACTIONS) {
      expect(ACTION_EVENT_TYPE[action], `no event type for ${action}`).toBeTruthy();
    }
    expect(Object.keys(ACTION_EVENT_TYPE)).toHaveLength(HISTORY_ACTIONS.length);
  });

  it('uses dotted lower-case names throughout (the published contract)', () => {
    for (const type of KNOWN_EVENT_TYPES) {
      expect(type, `${type} is not a dotted lower-case name`).toMatch(/^[a-z]+(?:[._][a-z]+)*$/);
    }
  });

  it('resolves a known action to its mapped type', () => {
    expect(eventTypeForAction('CREATED')).toBe('item.created');
    expect(eventTypeForAction('QUANTITY_CHANGE')).toBe('stock.adjusted');
    expect(eventTypeForAction('MOVED')).toBe('item.moved');
  });

  it('falls back to item.changed for an action a newer peer synced', () => {
    // Forward-compat: an unknown action must degrade, never throw — the same graceful degradation
    // the activity-kind grouping applies.
    expect(eventTypeForAction('SOMETHING_FROM_THE_FUTURE')).toBe(ITEM_CHANGED_TYPE);
    expect(eventTypeForAction('')).toBe(ITEM_CHANGED_TYPE);
  });

  it('does not let a prototype key masquerade as a mapped action', () => {
    // `ACTION_EVENT_TYPE` is a plain object literal, so a lookup of 'constructor'/'toString' would
    // find an inherited member if this used anything other than a value check.
    expect(eventTypeForAction('constructor')).toBe(ITEM_CHANGED_TYPE);
    expect(eventTypeForAction('toString')).toBe(ITEM_CHANGED_TYPE);
  });

  describe('KNOWN_EVENT_TYPES — the subscription catalogue', () => {
    it('covers every action-mapped type', () => {
      for (const type of Object.values(ACTION_EVENT_TYPE)) {
        expect(KNOWN_EVENT_TYPES).toContain(type);
      }
    });

    it('covers the types no action maps to', () => {
      // The four sources beyond the action map — each one absent from it, and each one genuinely
      // emitted, which is why the catalogue cannot be derived from the map alone.
      expect(KNOWN_EVENT_TYPES).toContain(ITEM_CHANGED_TYPE);
      expect(KNOWN_EVENT_TYPES).toContain(LOW_STOCK_TYPE);
      expect(KNOWN_EVENT_TYPES).toContain(OUT_OF_STOCK_TYPE);
      expect(KNOWN_EVENT_TYPES).toContain(EVENTS_TRUNCATED_TYPE);
      expect(KNOWN_EVENT_TYPES).toContain(LOOKUP_RESOLVED_TYPE);
    });

    it('is sorted and free of duplicates', () => {
      expect([...KNOWN_EVENT_TYPES]).toEqual([...KNOWN_EVENT_TYPES].sort());
      expect(new Set(KNOWN_EVENT_TYPES).size).toBe(KNOWN_EVENT_TYPES.length);
    });
  });
});
