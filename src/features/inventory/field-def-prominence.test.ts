import { describe, expect, it } from 'vitest';
import {
  FIELD_DEF_PROMINENCE_MODES,
  isKeyField,
  KEY_FIELD_PROMINENCE,
  orderByFieldProminence,
  serialiseFieldDefProminence,
  toFieldDefProminence,
} from './field-def-prominence';

/** A rankable stand-in: just the id used for assertions and the column being ranked on. */
const field = (id: string, prominence: string | null = null) => ({ id, prominence });
const ids = (list: readonly { id: string }[]) => list.map((f) => f.id);

describe('toFieldDefProminence', () => {
  it('keeps every mode this build renders', () => {
    for (const mode of FIELD_DEF_PROMINENCE_MODES) {
      expect(toFieldDefProminence(mode)).toBe(mode);
    }
  });

  it('reads null, undefined and blank as the default', () => {
    expect(toFieldDefProminence(null)).toBe('default');
    expect(toFieldDefProminence(undefined)).toBe('default');
    expect(toFieldDefProminence('')).toBe('default');
  });

  it('reads a mode this build does not recognise as the default, rather than throwing', () => {
    // A peer on a newer version may store a third mode — a "sink this to the bottom", say.
    // Storage keeps it verbatim; this boundary falls back to the rank that changes nothing.
    expect(toFieldDefProminence('trailing')).toBe('default');
  });

  it('does not fold case or whitespace, so storage has exactly one spelling of each mode', () => {
    expect(toFieldDefProminence('Key')).toBe('default');
    expect(toFieldDefProminence(' key ')).toBe('default');
  });
});

describe('isKeyField', () => {
  it('is true only for the stored key token', () => {
    expect(isKeyField(KEY_FIELD_PROMINENCE)).toBe(true);
    expect(isKeyField('default')).toBe(false);
    expect(isKeyField(null)).toBe(false);
    expect(isKeyField(undefined)).toBe(false);
    expect(isKeyField('trailing')).toBe(false);
  });
});

describe('serialiseFieldDefProminence', () => {
  it('stores "ordinary" as exactly one value — NULL — so an LWW merge sees no phantom edit', () => {
    expect(serialiseFieldDefProminence(null)).toBeNull();
    expect(serialiseFieldDefProminence(undefined)).toBeNull();
    expect(serialiseFieldDefProminence('')).toBeNull();
    expect(serialiseFieldDefProminence('   ')).toBeNull();
    expect(serialiseFieldDefProminence('default')).toBeNull();
  });

  it('trims, and keeps a mode it does not recognise verbatim', () => {
    expect(serialiseFieldDefProminence('  key  ')).toBe('key');
    // Refusing this would discard a newer peer's choice the moment an older device touched the row.
    expect(serialiseFieldDefProminence('trailing')).toBe('trailing');
  });

  it('round-trips: what it stores for a key field is what the render boundary reads back', () => {
    expect(isKeyField(serialiseFieldDefProminence(KEY_FIELD_PROMINENCE))).toBe(true);
  });
});

describe('orderByFieldProminence', () => {
  it('lifts key fields to the front', () => {
    const ordered = orderByFieldProminence([field('a'), field('b', 'key'), field('c')]);
    expect(ids(ordered)).toEqual(['b', 'a', 'c']);
  });

  it('is a stable partition, so the incoming order survives within each rank', () => {
    // This is what makes prominence compose with `category_fields.position` rather than replace
    // it: the caller's order (position, then name) is preserved inside both groups.
    const ordered = orderByFieldProminence([
      field('a'),
      field('b', 'key'),
      field('c'),
      field('d', 'key'),
      field('e'),
    ]);
    expect(ids(ordered)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('returns the same reference when nothing is key, so the common case allocates nothing', () => {
    const input = [field('a'), field('b')];
    expect(orderByFieldProminence(input)).toBe(input);
  });

  it('returns the same reference for an empty list', () => {
    const input: { id: string; prominence: string | null }[] = [];
    expect(orderByFieldProminence(input)).toBe(input);
  });

  it('does not mutate its input', () => {
    const input = [field('a'), field('b', 'key')];
    orderByFieldProminence(input);
    expect(ids(input)).toEqual(['a', 'b']);
  });

  it('treats a mode it does not recognise as ordinary rather than as key', () => {
    const ordered = orderByFieldProminence([field('a'), field('b', 'trailing')]);
    expect(ids(ordered)).toEqual(['a', 'b']);
  });

  it('leaves an all-key list in its incoming order', () => {
    const ordered = orderByFieldProminence([field('a', 'key'), field('b', 'key')]);
    expect(ids(ordered)).toEqual(['a', 'b']);
  });
});
