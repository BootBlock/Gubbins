/**
 * Unit tests for the saved count-sheet seam (issue #587).
 *
 * The module is pure and clock-free, so everything here is plain input → output: what counts
 * as work worth saving, how a saved sheet is reconciled against a location whose stock has
 * moved on, the eviction cap, and the rehydration guard that stands between untrusted
 * `localStorage` JSON and the count inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_COUNT_DRAFTS,
  capCountDrafts,
  draftFrom,
  normaliseCountDrafts,
  reconcilePresence,
  restoreCountSheet,
  sameCountDraft,
  type CountDraft,
} from './count-draft';
import type { FoundHereEntry, SerialisedPresence } from './cycle-count';

const AT = 1_700_000_000_000;

/** A count line, reduced to what the seam reads. */
const line = (key: string) => ({ key });
/** A serialised instance, reduced to what the seam reads. */
const instance = (itemId: string) => ({ itemId });

describe('draftFrom — what is worth saving', () => {
  it('keeps only entered counts, dropping blank and whitespace-only inputs', () => {
    const draft = draftFrom({ a: '4', b: '', c: '   ', d: '0' }, {}, [], AT);
    expect(draft).toEqual({ counts: { a: '4', d: '0' }, missing: [], found: [], savedAt: AT });
  });

  it('stores only instances flagged MISSING — PRESENT is the default, not a decision', () => {
    const presence: Record<string, SerialisedPresence> = { i1: 'PRESENT', i2: 'MISSING', i3: 'PRESENT' };
    expect(draftFrom({}, presence, [], AT)?.missing).toEqual(['i2']);
  });

  it('sorts the missing ids, so the same work compares equal whatever order it was flagged in', () => {
    const first = draftFrom({}, { z: 'MISSING', a: 'MISSING' }, [], AT);
    const second = draftFrom({}, { a: 'MISSING', z: 'MISSING' }, [], AT);
    expect(first?.missing).toEqual(['a', 'z']);
    expect(sameCountDraft(first, second)).toBe(true);
  });

  it('is null when nothing has been entered — an untouched sheet is not progress', () => {
    expect(draftFrom({}, {}, [], AT)).toBeNull();
    expect(draftFrom({ a: '', b: ' ' }, { i1: 'PRESENT' }, [], AT)).toBeNull();
  });

  it('treats a count of "0" as real work (counting nothing on the shelf is a finding)', () => {
    expect(draftFrom({ a: '0' }, {}, [], AT)).not.toBeNull();
  });
});

describe('sameCountDraft — the no-op guard', () => {
  const base = draftFrom({ a: '4' }, { i1: 'MISSING' }, [], AT);

  it('ignores savedAt, so a re-save of unchanged work does not bump the age', () => {
    expect(sameCountDraft(base, draftFrom({ a: '4' }, { i1: 'MISSING' }, [], AT + 60_000))).toBe(true);
  });

  it('spots a changed, added or removed count', () => {
    expect(sameCountDraft(base, draftFrom({ a: '5' }, { i1: 'MISSING' }, [], AT))).toBe(false);
    expect(sameCountDraft(base, draftFrom({ a: '4', b: '1' }, { i1: 'MISSING' }, [], AT))).toBe(false);
    expect(sameCountDraft(base, draftFrom({}, { i1: 'MISSING' }, [], AT))).toBe(false);
  });

  it('spots a changed presence flag', () => {
    expect(sameCountDraft(base, draftFrom({ a: '4' }, { i1: 'PRESENT' }, [], AT))).toBe(false);
  });

  it('compares null (nothing to save) correctly against a real draft', () => {
    expect(sameCountDraft(null, null)).toBe(true);
    expect(sameCountDraft(base, null)).toBe(false);
    expect(sameCountDraft(null, base)).toBe(false);
  });
});

describe('restoreCountSheet — opening a location onto saved work', () => {
  const draft: CountDraft = { counts: { 'w1|default': '8' }, missing: ['s1'], savedAt: AT };

  it('hands back the counts and missing flags that still have a line to sit on', () => {
    const sheet = restoreCountSheet(draft, [line('w1|default')], [instance('s1'), instance('s2')]);
    expect(sheet.counts).toEqual({ 'w1|default': '8' });
    expect(sheet.presence).toEqual({ s1: 'MISSING', s2: 'PRESENT' });
    expect(sheet.restoredEntries).toBe(2);
    expect(sheet.savedAt).toBe(AT);
  });

  it('drops a count for a lot that has been consumed since the sheet was saved', () => {
    const sheet = restoreCountSheet(draft, [line('w2|default')], []);
    expect(sheet.counts).toEqual({});
    expect(sheet.restoredEntries).toBe(0);
  });

  it('drops a missing flag for an instance that has left the location', () => {
    const sheet = restoreCountSheet(draft, [], [instance('s9')]);
    expect(sheet.presence).toEqual({ s9: 'PRESENT' });
    expect(sheet.restoredEntries).toBe(0);
  });

  it('reports nothing restored (and no age) for a location with no saved sheet', () => {
    const sheet = restoreCountSheet(undefined, [line('w1|default')], [instance('s1')]);
    expect(sheet.counts).toEqual({});
    expect(sheet.presence).toEqual({ s1: 'PRESENT' });
    expect(sheet.restoredEntries).toBe(0);
    expect(sheet.savedAt).toBeNull();
  });

  it('never pre-fills a line the auditor did not enter — the count stays blind', () => {
    const sheet = restoreCountSheet(draft, [line('w1|default'), line('w3|default')], []);
    expect(Object.keys(sheet.counts)).toEqual(['w1|default']);
  });
});

describe('reconcilePresence — a refetch mid-count', () => {
  it('keeps a judged flag, defaults a newly-arrived instance to PRESENT, drops a departed one', () => {
    const previous: Record<string, SerialisedPresence> = { s1: 'MISSING', s2: 'PRESENT', s3: 'MISSING' };
    expect(reconcilePresence([instance('s1'), instance('s2'), instance('s4')], previous)).toEqual({
      s1: 'MISSING',
      s2: 'PRESENT',
      s4: 'PRESENT',
    });
  });

  it('returns the very same object when nothing moved, so a refetch cannot loop the render', () => {
    const previous: Record<string, SerialisedPresence> = { s1: 'MISSING', s2: 'PRESENT' };
    expect(reconcilePresence([instance('s1'), instance('s2')], previous)).toBe(previous);
    expect(reconcilePresence([], {})).toEqual({});
  });
});

describe('capCountDrafts — bounding a store written on every keystroke', () => {
  /** `count` drafts, oldest first, keyed `loc0…locN`. */
  const many = (count: number): Record<string, CountDraft> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`loc${i}`, { counts: { a: '1' }, missing: [], savedAt: i }]),
    );

  it('leaves a map at or under the cap untouched (same object, no needless rewrite)', () => {
    const drafts = many(MAX_COUNT_DRAFTS);
    expect(capCountDrafts(drafts)).toBe(drafts);
  });

  it('evicts the oldest sheets when the cap is exceeded', () => {
    const capped = capCountDrafts(many(MAX_COUNT_DRAFTS + 3));
    expect(Object.keys(capped)).toHaveLength(MAX_COUNT_DRAFTS);
    // loc0..loc2 are the three oldest and are the ones dropped; the newest survives.
    expect(capped.loc0).toBeUndefined();
    expect(capped.loc2).toBeUndefined();
    expect(capped.loc3).toBeDefined();
    expect(capped[`loc${MAX_COUNT_DRAFTS + 2}`]).toBeDefined();
  });

  it('sorts a draft with no usable stamp as the oldest', () => {
    const drafts: Record<string, CountDraft> = {
      ...many(MAX_COUNT_DRAFTS),
      undated: { counts: { a: '1' }, missing: [], savedAt: null },
    };
    expect(capCountDrafts(drafts).undated).toBeUndefined();
  });
});

describe('found-here entries survive a paused count (issue #640)', () => {
  const bulk: FoundHereEntry = { itemId: 'a', name: 'Loose screws', serialNo: null, mode: 'DISCRETE' };
  const unit: FoundHereEntry = { itemId: 'b', name: 'Multimeter', serialNo: 3, mode: 'SERIALISED' };

  it('saves a find even when nothing has been typed yet — noticing it IS the work', () => {
    expect(draftFrom({}, {}, [bulk], AT)).toEqual({ counts: {}, missing: [], found: [bulk], savedAt: AT });
  });

  it('hands back the find and the quantity typed against its line', () => {
    // The line a find creates is one the location's own read will never produce, so restoring
    // has to keep both halves or the quantity is thrown away with nothing left to say why.
    const draft = draftFrom({ 'a|': '12' }, {}, [bulk], AT)!;
    const sheet = restoreCountSheet(draft, [line('w1|')], []);
    expect(sheet.found).toEqual([bulk]);
    expect(sheet.counts).toEqual({ 'a|': '12' });
    expect(sheet.restoredEntries).toBe(2);
  });

  it('drops a find the database now supplies itself, and the count typed against it', () => {
    const draft = draftFrom({ 'a|': '12' }, {}, [bulk], AT)!;
    const sheet = restoreCountSheet(draft, [line('a|')], []);
    expect(sheet.found).toEqual([]);
    // The database's own line for that lot is on the sheet with its real expected quantity, and
    // a count entered against an expected-zero line is not an answer to that question.
    expect(sheet.counts).toEqual({ 'a|': '12' });
  });

  it('drops a found instance the records now place here', () => {
    const draft = draftFrom({}, {}, [unit], AT)!;
    expect(restoreCountSheet(draft, [], [instance('b')]).found).toEqual([]);
  });

  it('tells two sheets apart by what was found on them', () => {
    const base = draftFrom({}, {}, [bulk], AT);
    expect(sameCountDraft(base, draftFrom({}, {}, [bulk], AT + 60_000))).toBe(true);
    expect(sameCountDraft(base, draftFrom({}, {}, [bulk, unit], AT))).toBe(false);
    expect(sameCountDraft(base, draftFrom({}, {}, [unit], AT))).toBe(false);
  });
});

describe('normaliseCountDrafts — untrusted rehydrated JSON', () => {
  it('supplies an empty found list for a sheet stored before finds existed (issue #640)', () => {
    const stored = { locA: { counts: { 'w1|default': '8' }, missing: [], savedAt: AT } };
    expect(normaliseCountDrafts(stored).locA?.found).toEqual([]);
  });

  it('drops a stored find that has lost the tracking mode telling us what to do with it', () => {
    const stored = {
      locA: {
        counts: {},
        missing: [],
        found: [
          { itemId: 'a', name: 'Screws', serialNo: null, mode: 'DISCRETE' },
          { itemId: 'b', name: 'Mystery', serialNo: null }, // no mode — nothing can act on it
          { itemId: 'c', name: 'Gauge', serialNo: null, mode: 'CONSUMABLE_GAUGE' }, // not countable
          { itemId: '', name: 'Nameless', serialNo: null, mode: 'DISCRETE' },
          { itemId: 'a', name: 'Screws again', serialNo: null, mode: 'DISCRETE' }, // duplicate
        ],
        savedAt: AT,
      },
    };
    expect(normaliseCountDrafts(stored).locA?.found).toEqual([
      { itemId: 'a', name: 'Screws', serialNo: null, mode: 'DISCRETE' },
    ]);
  });

  it('reads a well-formed map back verbatim', () => {
    const stored = { locA: { counts: { 'w1|default': '8' }, missing: ['s1'], found: [], savedAt: AT } };
    expect(normaliseCountDrafts(stored)).toEqual(stored);
  });

  it('is empty for anything that is not a map', () => {
    for (const value of [null, undefined, 42, 'x', ['a'], true]) {
      expect(normaliseCountDrafts(value)).toEqual({});
    }
  });

  it('drops entries whose counts and flags are unusable rather than passing them to an input', () => {
    const drafts = normaliseCountDrafts({
      good: { counts: { a: '4' }, missing: [], savedAt: AT },
      notAnObject: 'nope',
      emptied: { counts: { a: '', b: '  ' }, missing: [], savedAt: AT },
      badTypes: { counts: { a: 7, b: null }, missing: [{}, 3, ''], savedAt: AT },
    });
    expect(Object.keys(drafts)).toEqual(['good']);
  });

  it('keeps a non-string-valued count out while keeping its usable siblings', () => {
    const drafts = normaliseCountDrafts({ locA: { counts: { a: '4', b: 7 }, missing: [], savedAt: AT } });
    expect(drafts.locA?.counts).toEqual({ a: '4' });
  });

  it('reduces a nonsense timestamp to null rather than inventing a date to show the auditor', () => {
    const drafts = normaliseCountDrafts({ locA: { counts: { a: '4' }, missing: [], savedAt: 'yesterday' } });
    expect(drafts.locA?.savedAt).toBeNull();
  });

  it('dedupes and sorts a hand-edited missing list', () => {
    const drafts = normaliseCountDrafts({ locA: { counts: {}, missing: ['z', 'a', 'z'], savedAt: AT } });
    expect(drafts.locA?.missing).toEqual(['a', 'z']);
  });

  it('re-applies the cap, so an oversized stored blob cannot smuggle an unbounded map in', () => {
    const stored = Object.fromEntries(
      Array.from({ length: MAX_COUNT_DRAFTS + 5 }, (_, i) => [
        `loc${i}`,
        { counts: { a: '1' }, missing: [], savedAt: i },
      ]),
    );
    expect(Object.keys(normaliseCountDrafts(stored))).toHaveLength(MAX_COUNT_DRAFTS);
  });

  it('cannot be made to pollute the prototype through a `__proto__` location or line key', () => {
    const stored = JSON.parse(
      '{"__proto__":{"counts":{"a":"1"},"missing":[],"savedAt":1},"locA":{"counts":{"__proto__":"9","a":"4"},"missing":[],"savedAt":1}}',
    ) as unknown;
    const drafts = normaliseCountDrafts(stored);
    expect(({} as Record<string, unknown>).counts).toBeUndefined();
    expect(Object.getPrototypeOf(drafts.locA!.counts)).toBe(Object.prototype);
    expect(drafts.locA?.counts.a).toBe('4');
  });
});
