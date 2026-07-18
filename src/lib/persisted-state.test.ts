import { describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  adoptUnversioned,
  isPlainObject,
  normaliseArray,
  normaliseBoolean,
  normaliseInteger,
  normaliseOneOf,
} from './persisted-state';

const COLOURS = ['red', 'green', 'blue'] as const;

describe('normaliseOneOf', () => {
  it('keeps a value that is in the allowed set', () => {
    expect(normaliseOneOf('green', COLOURS, 'red')).toBe('green');
  });

  it('falls back for a value retired from the union', () => {
    expect(normaliseOneOf('chartreuse', COLOURS, 'red')).toBe('red');
  });

  it.each([[undefined], [null], [0], [{}], [[]], [['green']]])(
    'falls back for the non-member %p',
    (value) => {
      expect(normaliseOneOf(value, COLOURS, 'red')).toBe('red');
    },
  );

  it('matches on identity, so a numeric union works too', () => {
    expect(normaliseOneOf(30, [7, 30, 90] as const, 7)).toBe(30);
    // …and a stringified number is not the number.
    expect(normaliseOneOf('30', [7, 30, 90] as const, 7)).toBe(7);
  });
});

describe('normaliseBoolean', () => {
  it('keeps a real boolean, including false', () => {
    expect(normaliseBoolean(true, false)).toBe(true);
    expect(normaliseBoolean(false, true)).toBe(false);
  });

  it.each([[undefined], [null], ['true'], [1], [0]])('falls back for %p', (value) => {
    expect(normaliseBoolean(value, true)).toBe(true);
  });
});

describe('normaliseArray', () => {
  it('keeps an array as-is when no item guard is given', () => {
    expect(normaliseArray([1, 'two', null])).toEqual([1, 'two', null]);
  });

  it.each([[undefined], [null], ['[]'], [{ 0: 'a', length: 1 }]])(
    'falls back for the non-array %p',
    (value) => {
      expect(normaliseArray(value, ['fallback'])).toEqual(['fallback']);
    },
  );

  it('filters members through an item guard when one is given', () => {
    const isString = (c: unknown): c is string => typeof c === 'string';
    expect(normaliseArray(['a', 1, null, 'b'], [], isString)).toEqual(['a', 'b']);
  });
});

describe('isPlainObject', () => {
  it('accepts a plain object', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it.each([[null], [undefined], [[]], ['{}'], [1]])('rejects %p', (value) => {
    expect(isPlainObject(value)).toBe(false);
  });
});

describe('normaliseInteger', () => {
  it('keeps a whole number', () => {
    expect(normaliseInteger(5, 0)).toBe(5);
  });

  it('truncates towards zero rather than rejecting a fraction', () => {
    expect(normaliseInteger(5.9, 0)).toBe(5);
    expect(normaliseInteger(-5.9, 0)).toBe(-5);
  });

  it.each([[undefined], [null], ['5'], [NaN], [Infinity]])('falls back for %p', (value) => {
    expect(normaliseInteger(value, 42)).toBe(42);
  });

  it('clamps into the given bounds', () => {
    expect(normaliseInteger(99, 0, { min: 0, max: 10 })).toBe(10);
    expect(normaliseInteger(-99, 0, { min: 0, max: 10 })).toBe(0);
    expect(normaliseInteger(-99, 0, { min: 0 })).toBe(0);
  });
});

describe('adoptUnversioned', () => {
  it('adopts a v0 payload verbatim', () => {
    const persisted = { searches: [{ id: 'a', name: 'Spares' }] };
    expect(adoptUnversioned(persisted)).toBe(persisted);
  });

  /**
   * The reason the helper exists at all: zustand hydrates with `undefined` — silently wiping the
   * user's state — when the stored version differs from the declared one and no `migrate` is set.
   * Both halves are asserted so the pairing can't be half-undone by a later edit.
   */
  describe('paired with a version bump', () => {
    interface Counter {
      readonly count: number;
    }

    /** Seed a v0 payload under `name`, then build the v1 store that reads it back. */
    function rehydrate(name: string, migrate?: (persisted: unknown) => Counter) {
      localStorage.setItem(name, JSON.stringify({ state: { count: 7 }, version: 0 }));
      return create<Counter>()(persist(() => ({ count: 0 }), { name, version: 1, migrate }));
    }

    it('keeps the persisted state across the 0 → 1 bump', () => {
      expect(rehydrate('test:adopt', adoptUnversioned).getState().count).toBe(7);
    });

    it('would discard it if the version were bumped without a migrate', () => {
      // Documents the failure mode, so the pairing is understood rather than cargo-culted.
      // Zustand logs an error on this path; it's the expected outcome here, not a test failure.
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(rehydrate('test:bare').getState().count).toBe(0);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });
  });
});
