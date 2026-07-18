/**
 * Guards the user-facing event catalogue (webhooks plan `W2`).
 *
 * The catalogue is hand-written copy (§5.1 explains why it cannot be generated), so the tests here
 * exist to make that hand-maintenance safe: coverage is asserted **in both directions** against the
 * machine vocabulary, so neither list can gain a member the other lacks. Adding an event type
 * without describing it — or describing one that is never emitted — fails the build rather than
 * shipping a picker that lies about what will arrive.
 */
import { describe, expect, it } from 'vitest';
import { EN_CATALOG } from '@/features/i18n/messages';
import { KNOWN_EVENT_TYPES, LOOKUP_RESOLVED_TYPE, EVENTS_TRUNCATED_TYPE } from './event-types';
import {
  CATALOGUED_EVENT_TYPES,
  DEFAULT_SUBSCRIBED_EVENT_TYPES,
  EVENT_CATALOGUE,
  EVENT_GROUP_ORDER,
  eventCatalogueByGroup,
  eventCatalogueEntry,
} from './event-catalogue';

describe('event catalogue', () => {
  describe('coverage against the emitted vocabulary', () => {
    it('describes every event type the system can emit', () => {
      const missing = KNOWN_EVENT_TYPES.filter((t) => !CATALOGUED_EVENT_TYPES.includes(t));
      expect(
        missing,
        `these event types are emitted but have no catalogue entry, so the picker cannot offer them`,
      ).toEqual([]);
    });

    it('describes nothing that is never emitted', () => {
      const phantom = CATALOGUED_EVENT_TYPES.filter((t) => !KNOWN_EVENT_TYPES.includes(t));
      expect(
        phantom,
        `these catalogue entries name event types nothing emits, so subscribing to them would never fire`,
      ).toEqual([]);
    });

    it('has no duplicate entries', () => {
      expect(new Set(CATALOGUED_EVENT_TYPES).size).toBe(CATALOGUED_EVENT_TYPES.length);
    });
  });

  describe('copy', () => {
    it('every label equals its message key in the English catalog', () => {
      // The `NAV_DESTINATIONS` precedent: the literal here is the fallback and the stable search
      // text, so it is only meaningful while it matches the catalog byte-for-byte.
      for (const entry of EVENT_CATALOGUE) {
        expect(EN_CATALOG[entry.labelKey], `${entry.type} label`).toBe(entry.label);
      }
    });

    it('every description equals its message key in the English catalog', () => {
      for (const entry of EVENT_CATALOGUE) {
        expect(EN_CATALOG[entry.descriptionKey], `${entry.type} description`).toBe(entry.description);
      }
    });

    it('gives every group heading a message key', () => {
      for (const group of EVENT_GROUP_ORDER) {
        expect(EN_CATALOG[`events.group.${group}`], `group ${group}`).toBeTruthy();
      }
    });

    it('describes when each event fires, not merely what it is called', () => {
      // A description that just restates the label teaches nobody when to subscribe.
      for (const entry of EVENT_CATALOGUE) {
        expect(entry.description.length, `${entry.type} description too short`).toBeGreaterThan(
          entry.label.length,
        );
      }
    });
  });

  describe('grouping', () => {
    it('assigns every entry to a known group', () => {
      for (const entry of EVENT_CATALOGUE) {
        expect(EVENT_GROUP_ORDER, `${entry.type} group`).toContain(entry.group);
      }
    });

    it('groups without losing or duplicating an entry', () => {
      const grouped = eventCatalogueByGroup().flatMap((g) => g.entries);
      expect(grouped).toHaveLength(EVENT_CATALOGUE.length);
      expect(new Set(grouped.map((e) => e.type)).size).toBe(EVENT_CATALOGUE.length);
    });

    it('omits empty groups rather than rendering a bare heading', () => {
      for (const { entries } of eventCatalogueByGroup()) {
        expect(entries.length).toBeGreaterThan(0);
      }
    });
  });

  describe('defaults', () => {
    it('never pre-selects the lookup event', () => {
      // It publishes what somebody searched for. The bridge treats it as its own explicit opt-in;
      // pre-ticking it here would quietly undo that.
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES).not.toContain(LOOKUP_RESOLVED_TYPE);
    });

    it('never pre-selects the truncation diagnostic', () => {
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES).not.toContain(EVENTS_TRUNCATED_TYPE);
    });

    it('pre-selects the everyday inventory events', () => {
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES).toContain('item.created');
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES).toContain('stock.adjusted');
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES).toContain('item.moved');
      expect(DEFAULT_SUBSCRIBED_EVENT_TYPES.length).toBeGreaterThan(0);
    });

    it('marks exactly one entry sensitive, and it is the lookup event', () => {
      const sensitive = EVENT_CATALOGUE.filter((e) => e.sensitive);
      expect(sensitive.map((e) => e.type)).toEqual([LOOKUP_RESOLVED_TYPE]);
    });
  });

  describe('lookup', () => {
    it('finds an entry by its dotted type', () => {
      expect(eventCatalogueEntry('item.created')?.label).toBe('Item created');
    });

    it('returns undefined for a type it does not know', () => {
      expect(eventCatalogueEntry('item.nonexistent')).toBeUndefined();
      expect(eventCatalogueEntry('')).toBeUndefined();
    });
  });
});
