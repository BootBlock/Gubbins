/**
 * Unit tests for the generic field-selection engine (`field-select.ts`) — parsing/validation,
 * one-level nesting, alias expansion, deterministic ordering, and lazy resolution. Driven over
 * a tiny synthetic registry so no database or transport is involved.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FieldSelectionError,
  hasSelection,
  parseSelection,
  projectThrough,
  splitList,
  type FieldNode,
  type FieldRegistry,
} from './field-select.ts';
import { MAX_SELECTED_FIELDS } from './limits.ts';

interface Ctx {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly tags: readonly { readonly k: string; readonly v: number }[];
}

const REGISTRY: FieldRegistry<Ctx> = new Map<string, FieldNode<Ctx>>([
  ['id', { resolve: (c) => c.id }],
  ['name', { resolve: (c) => c.name }],
  ['price', { resolve: (c) => c.price }],
  ['tags', { resolve: (c) => c.tags, elementKeys: ['k', 'v'] }],
]);

const DEFAULTS = ['id', 'name'];
const ALIASES = { extras: ['price', 'tags'] };

const cfg = { registry: REGISTRY, defaults: DEFAULTS, aliases: ALIASES };

const CTX: Ctx = { id: 'x1', name: 'Widget', price: 9.5, tags: [{ k: 'colour', v: 1 }] };

describe('splitList', () => {
  it('splits a comma string, trims, and drops empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
  });
  it('accepts a string array (elements may contain commas)', () => {
    expect(splitList(['a', 'b,c'])).toEqual(['a', 'b', 'c']);
  });
  it('ignores non-strings and nullish', () => {
    expect(splitList(undefined)).toEqual([]);
    expect(splitList(42)).toEqual([]);
  });
});

describe('hasSelection', () => {
  it('is true when either param is present, false otherwise', () => {
    expect(hasSelection({})).toBe(false);
    expect(hasSelection({ fields: 'id' })).toBe(true);
    expect(hasSelection({ include: 'price' })).toBe(true);
  });
});

describe('parseSelection', () => {
  it('returns the endpoint defaults (in registry order) when neither param is given', () => {
    expect(parseSelection(cfg, {}).map((s) => s.name)).toEqual(['id', 'name']);
  });

  it('projects to exactly the named fields with `fields`', () => {
    expect(parseSelection(cfg, { fields: 'price,name' }).map((s) => s.name)).toEqual(['name', 'price']);
  });

  it('adds extended fields on top of the defaults with `include`', () => {
    expect(parseSelection(cfg, { include: 'price' }).map((s) => s.name)).toEqual(['id', 'name', 'price']);
  });

  it('unions `include` on top of `fields`', () => {
    expect(parseSelection(cfg, { fields: 'name', include: 'tags' }).map((s) => s.name)).toEqual([
      'name',
      'tags',
    ]);
  });

  it('expands an include alias', () => {
    expect(parseSelection(cfg, { include: 'extras' }).map((s) => s.name)).toEqual([
      'id',
      'name',
      'price',
      'tags',
    ]);
  });

  it('captures a nested sub-field selection', () => {
    const sel = parseSelection(cfg, { fields: 'tags.k' });
    expect(sel).toHaveLength(1);
    expect(sel[0]!.name).toBe('tags');
    expect([...sel[0]!.subKeys!]).toEqual(['k']);
  });

  it('a bare selection of a nestable field means all sub-keys (null)', () => {
    expect(parseSelection(cfg, { fields: 'tags' })[0]!.subKeys).toBeNull();
  });

  it('rejects an unknown field, listing the valid vocabulary', () => {
    expect(() => parseSelection(cfg, { fields: 'bogus' })).toThrow(FieldSelectionError);
    try {
      parseSelection(cfg, { fields: 'bogus,name' });
    } catch (e) {
      expect((e as Error).message).toContain('bogus');
      expect((e as Error).message).toContain('Valid fields');
    }
  });

  it('rejects an unknown include name', () => {
    expect(() => parseSelection(cfg, { include: 'nope' })).toThrow(FieldSelectionError);
  });

  it('rejects an empty `fields`', () => {
    expect(() => parseSelection(cfg, { fields: '' })).toThrow(/at least one field/);
  });

  it('rejects nesting deeper than one level', () => {
    expect(() => parseSelection(cfg, { fields: 'tags.k.deep' })).toThrow(/too deep/);
  });

  it('rejects a dotted path on a scalar field', () => {
    expect(() => parseSelection(cfg, { fields: 'price.x' })).toThrow(/not a nested field/);
  });

  it('rejects an unknown sub-field of a nestable field', () => {
    expect(() => parseSelection(cfg, { fields: 'tags.zzz' })).toThrow(/Unknown sub-field/);
  });

  it('rejects more than the maximum number of fields', () => {
    const many = Array.from({ length: MAX_SELECTED_FIELDS + 1 }, () => 'id').join(',');
    expect(() => parseSelection(cfg, { fields: many })).toThrow(/Too many fields/);
  });
});

describe('projectThrough', () => {
  it('emits only the selected fields', async () => {
    const out = await projectThrough(REGISTRY, parseSelection(cfg, { fields: 'name,price' }), CTX);
    expect(out).toEqual({ name: 'Widget', price: 9.5 });
  });

  it('restricts nested array elements to the chosen sub-keys', async () => {
    const out = await projectThrough(REGISTRY, parseSelection(cfg, { fields: 'tags.k' }), CTX);
    expect(out).toEqual({ tags: [{ k: 'colour' }] });
  });

  it('emits whole array elements for a bare nested field', async () => {
    const out = await projectThrough(REGISTRY, parseSelection(cfg, { fields: 'tags' }), CTX);
    expect(out).toEqual({ tags: [{ k: 'colour', v: 1 }] });
  });

  it('only runs resolvers for selected fields (lazy)', async () => {
    const priceResolver = vi.fn((c: Ctx) => c.price);
    const reg: FieldRegistry<Ctx> = new Map<string, FieldNode<Ctx>>([
      ['id', { resolve: (c) => c.id }],
      ['price', { resolve: priceResolver }],
    ]);
    await projectThrough(reg, parseSelection({ registry: reg, defaults: ['id'] }, { fields: 'id' }), CTX);
    expect(priceResolver).not.toHaveBeenCalled();
  });
});
