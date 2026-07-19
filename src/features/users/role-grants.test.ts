import { describe, expect, it } from 'vitest';
import {
  fromGrantModel,
  isKeyTicked,
  setGrantsEverything,
  toGrantModel,
  toggleKey,
  toggleSubject,
} from './role-grants';
import { PERMISSION_KEYS, permissionKeysFor } from './permission-registry';

/** Round-trip a grant list through the editor's model without touching anything. */
function roundTrip(grants: readonly string[]): readonly string[] {
  return fromGrantModel(toGrantModel(grants));
}

describe('role-grants — round-tripping', () => {
  it('preserves an ordinary set of explicit keys', () => {
    const grants = ['items:read', 'items:write', 'stock:write'];
    expect([...roundTrip(grants)].sort()).toEqual([...grants].sort());
  });

  it('preserves the global wildcard rather than expanding it to today’s keys', () => {
    // Expanding `*` would silently cap the Administrator role at the keys this build knows, so a
    // capability added in a later release would not be granted to the one role defined as having
    // everything.
    expect(roundTrip(['*'])).toEqual(['*']);
  });

  it('preserves a subject wildcard when its row is left alone', () => {
    expect(roundTrip(['items:*'])).toEqual(['items:*']);
  });

  it('preserves grants this build does not recognise', () => {
    // A peer on a newer Gubbins can sync a role holding a key this build has never heard of.
    // Editing that role here must not strip it.
    const grants = ['items:read', 'teleporter:engage'];
    expect([...roundTrip(grants)].sort()).toEqual(['items:read', 'teleporter:engage']);
  });

  it('drops the rows underneath the global wildcard, so turning it off does not leave a ghost set', () => {
    const model = toGrantModel(['*', 'items:read']);
    expect(fromGrantModel(model)).toEqual(['*']);
  });
});

describe('role-grants — reading the grid', () => {
  it('ticks every key when the role grants everything', () => {
    const model = toGrantModel(['*']);
    for (const key of PERMISSION_KEYS) {
      expect(isKeyTicked(model, key), key).toBe(true);
    }
  });

  it('ticks every action of a wildcarded subject and nothing else', () => {
    const model = toGrantModel(['items:*']);
    for (const key of permissionKeysFor('items')) {
      expect(isKeyTicked(model, key), key).toBe(true);
    }
    expect(isKeyTicked(model, 'stock:read')).toBe(false);
  });

  it('ticks only the explicit keys a role holds', () => {
    const model = toGrantModel(['items:read']);
    expect(isKeyTicked(model, 'items:read')).toBe(true);
    expect(isKeyTicked(model, 'items:write')).toBe(false);
  });

  it('keeps a subject wildcard when an explicit key for the same subject also appears', () => {
    // `items:*` plus `items:read` is still "every action" — narrowing to the explicit key would
    // quietly remove permissions the role actually held.
    const model = toGrantModel(['items:*', 'items:read']);
    expect(model.subjects.get('items')).toEqual({ mode: 'wildcard' });
    expect(fromGrantModel(model)).toEqual(['items:*']);
  });
});

describe('role-grants — editing', () => {
  it('converts a wildcarded row to explicit keys once a box in it is touched', () => {
    const model = toggleKey(toGrantModel(['items:*']), 'items:delete', false);
    const grants = fromGrantModel(model);
    // The wildcard is gone, replaced by exactly what the boxes now show.
    expect(grants).not.toContain('items:*');
    expect([...grants].sort()).toEqual(['items:read', 'items:write']);
  });

  it('leaves other subjects untouched when one row is edited', () => {
    const model = toggleKey(toGrantModel(['items:*', 'stock:*']), 'items:read', false);
    expect(fromGrantModel(model)).toContain('stock:*');
  });

  it('ticks and un-ticks a single key', () => {
    let model = toGrantModel([]);
    model = toggleKey(model, 'items:read', true);
    expect(fromGrantModel(model)).toEqual(['items:read']);
    model = toggleKey(model, 'items:read', false);
    expect(fromGrantModel(model)).toEqual([]);
  });

  it('selects and clears a whole subject at once', () => {
    let model = toggleSubject(toGrantModel([]), 'items', true);
    expect([...fromGrantModel(model)].sort()).toEqual([...permissionKeysFor('items')].sort());
    model = toggleSubject(model, 'items', false);
    expect(fromGrantModel(model)).toEqual([]);
  });

  it('keeps unrecognised grants across an edit', () => {
    const model = toggleKey(toGrantModel(['teleporter:engage']), 'items:read', true);
    expect([...fromGrantModel(model)].sort()).toEqual(['items:read', 'teleporter:engage']);
  });

  it('restores the underlying rows when the global wildcard is switched off again', () => {
    // The rows are held underneath rather than discarded, so ticking "allow everything" and
    // changing your mind does not silently wipe the permission set you had built.
    const built = toggleKey(toGrantModel([]), 'items:read', true);
    const everything = setGrantsEverything(built, true);
    expect(fromGrantModel(everything)).toEqual(['*']);
    expect(fromGrantModel(setGrantsEverything(everything, false))).toEqual(['items:read']);
  });
});
