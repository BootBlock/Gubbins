/**
 * Unit tests for the constrained OData `$filter` → SearchAST compiler. Pure (no DB): they
 * assert the produced AST shape for the supported grammar and a {@link BadQueryError} for
 * everything outside the subset.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_FIELD_NAMES, TAG_FIELD } from '@/db/search/parseASTtoSQL.ts';
import { ITEM_FIELD_REGISTRY } from './item-view.ts';
import {
  FILTERABLE_AST_FIELDS,
  FILTERABLE_FIELD_NAMES,
  FILTERABLE_FIELD_TARGETS,
  parseODataFilter,
} from './odata-filter.ts';
import { BadQueryError } from './odata.ts';

describe('parseODataFilter — supported grammar', () => {
  it('compiles a single comparison, wrapping a lone condition in an AND group', () => {
    expect(parseODataFilter('quantity gt 10')).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      conditions: [{ field: 'quantity', operator: 'GREATER_THAN', value: 10 }],
    });
  });

  it('maps eq/lt and string / number / boolean literals', () => {
    expect(parseODataFilter("name eq 'M3 Bolt'").conditions[0]).toEqual({
      field: 'name',
      operator: 'EQUALS',
      value: 'M3 Bolt',
    });
    expect(parseODataFilter('quantity lt 5').conditions[0]).toMatchObject({
      operator: 'LESS_THAN',
      value: 5,
    });
  });

  // Not the AST's CONTAINS: that is the app's FTS-backed search-box match, which cannot see
  // inside a word, and OData §5.1.1.8 promises a substring test (issue #369).
  it('compiles the contains() function to SUBSTRING, not the FTS-backed CONTAINS', () => {
    expect(parseODataFilter("contains(name,'bolt')").conditions[0]).toEqual({
      field: 'name',
      operator: 'SUBSTRING',
      value: 'bolt',
    });
  });

  it('compiles contains() to SUBSTRING on every filterable field, tags included', () => {
    for (const field of ['description', 'mpn', 'barcode', 'serialNumber', 'tags']) {
      expect(parseODataFilter(`contains(${field},'x')`).conditions[0]).toMatchObject({
        operator: 'SUBSTRING',
      });
    }
  });

  it('aliases categoryId/locationId onto the AST category/location fields', () => {
    expect(parseODataFilter("categoryId eq 'c1'").conditions[0]).toMatchObject({ field: 'category' });
    expect(parseODataFilter("locationId eq 'l1'").conditions[0]).toMatchObject({ field: 'location' });
  });

  it('composes with and/or (and binds tighter than or)', () => {
    const ast = parseODataFilter("name eq 'a' and quantity gt 1 or quantity lt 0");
    // or is the root; its left is the (name and quantity) AND-group.
    expect(ast.logicalOperator).toBe('OR');
    expect(ast.conditions).toHaveLength(2);
    const left = ast.conditions[0] as { type: string; logicalOperator: string; conditions: unknown[] };
    expect(left.type).toBe('GROUP');
    expect(left.logicalOperator).toBe('AND');
    expect(left.conditions).toHaveLength(2);
  });

  it('honours parentheses for grouping', () => {
    const ast = parseODataFilter("(name eq 'a' or name eq 'b') and quantity gt 1");
    expect(ast.logicalOperator).toBe('AND');
    const first = ast.conditions[0] as { type: string; logicalOperator: string };
    expect(first.type).toBe('GROUP');
    expect(first.logicalOperator).toBe('OR');
  });

  it('unescapes a doubled single-quote in a string literal', () => {
    expect(parseODataFilter("name eq 'O''Brien'").conditions[0]).toMatchObject({ value: "O'Brien" });
  });
});

describe('parseODataFilter — negation (issue #139)', () => {
  it('compiles ne to an EQUALS under a negated group', () => {
    expect(parseODataFilter("name ne 'M3 Bolt'")).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      negate: true,
      conditions: [{ field: 'name', operator: 'EQUALS', value: 'M3 Bolt' }],
    });
  });

  it('compiles not over a single comparison', () => {
    expect(parseODataFilter("not name eq 'M3 Bolt'")).toEqual(parseODataFilter("name ne 'M3 Bolt'"));
  });

  it('compiles not over a bracketed group, negating it in place', () => {
    const ast = parseODataFilter("not (name eq 'a' or name eq 'b')");
    expect(ast.logicalOperator).toBe('OR');
    expect(ast.negate).toBe(true);
    expect(ast.conditions).toHaveLength(2);
  });

  it('compiles not over a function call', () => {
    expect(parseODataFilter("not contains(name,'bolt')")).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      negate: true,
      conditions: [{ field: 'name', operator: 'SUBSTRING', value: 'bolt' }],
    });
  });

  it('binds not to one primary, so "not a and b" is "(not a) and b"', () => {
    const ast = parseODataFilter("not name eq 'a' and quantity gt 1");
    expect(ast.logicalOperator).toBe('AND');
    expect(ast.negate).toBeUndefined();
    expect(ast.conditions).toHaveLength(2);
    expect(ast.conditions[0]).toMatchObject({ negate: true });
    expect(ast.conditions[1]).toMatchObject({ operator: 'GREATER_THAN' });
  });

  it('cancels a double negation', () => {
    expect(parseODataFilter("not not name eq 'a'")).toEqual(parseODataFilter("name eq 'a'"));
  });
});

describe('parseODataFilter — the field vocabulary (issue #143)', () => {
  /**
   * The drift guard the issue asks for. The OData property map and the app's own `ITEM_FIELDS`
   * are parallel exhaustive lists, and they *had* diverged: `barcode` and `favourite` were
   * searchable in the app but unreachable over the API, so a scanner integration could not look
   * an item up by its GTIN. Neither list may now grow without the other.
   */
  it('reaches every field the app itself can filter on, and nothing it cannot', () => {
    const reachable = new Set(FILTERABLE_AST_FIELDS);
    for (const field of ITEM_FIELD_NAMES) expect([...reachable]).toContain(field);
    // `tag` is a valid AST field but lives outside ITEM_FIELDS (it lowers to an EXISTS over the
    // item↔tag join, not a column), so it is named explicitly rather than assumed.
    expect([...reachable]).toContain(TAG_FIELD);
    const known = new Set([...ITEM_FIELD_NAMES, TAG_FIELD]);
    for (const field of reachable) expect([...known]).toContain(field);
  });

  it('can read back every field it can filter on', () => {
    // Each filterable field must have at least one accepted spelling that is also a projectable
    // item field, so `$filter=<x> …` always pairs with `$select=<x>`.
    const readable = new Map<string, string[]>();
    for (const [name, field] of FILTERABLE_FIELD_TARGETS) {
      if (ITEM_FIELD_REGISTRY.has(name)) readable.set(field, [...(readable.get(field) ?? []), name]);
    }
    for (const field of FILTERABLE_AST_FIELDS) {
      expect(readable.get(field), `no readable spelling of the filterable field "${field}"`).toBeDefined();
    }
  });

  it('accepts the app short name and the published camelCase name for the same field', () => {
    const pairs: [string, string][] = [
      ['serialNumber', 'serial'],
      ['unitCost', 'cost'],
      ['purchasePrice', 'price'],
      ['currentValue', 'value'],
      ['isFavourite', 'favourite'],
      ['isActive', 'active'],
      ['trackingMode', 'tracking'],
      ['expiryDate', 'expiry'],
      ['warrantyExpiresAt', 'warranty'],
      ['reorderPoint', 'reorder'],
    ];
    for (const [published, short] of pairs) {
      expect(parseODataFilter(`${published} eq 'x'`).conditions[0]).toMatchObject({ field: short });
    }
  });

  it('matches field names case-insensitively', () => {
    expect(parseODataFilter("BarCode eq '5012345678900'").conditions[0]).toMatchObject({
      field: 'barcode',
      operator: 'EQUALS',
      value: '5012345678900',
    });
  });

  it('compiles a barcode lookup — the scanner integration the drift blocked', () => {
    expect(parseODataFilter("barcode eq '5012345678900'").conditions[0]).toMatchObject({
      field: 'barcode',
      value: '5012345678900',
    });
  });

  it('compiles the favourite flag from a boolean literal', () => {
    expect(parseODataFilter('favourite eq true').conditions[0]).toMatchObject({
      field: 'favourite',
      operator: 'EQUALS',
      value: true,
    });
  });

  it('compiles tag/tags onto the AST tag field, exact and substring', () => {
    expect(parseODataFilter("tag eq 'fragile'").conditions[0]).toMatchObject({
      field: 'tag',
      operator: 'EQUALS',
      value: 'fragile',
    });
    expect(parseODataFilter("contains(tags,'expo')").conditions[0]).toMatchObject({
      field: 'tag',
      operator: 'SUBSTRING',
      value: 'expo',
    });
  });

  it('compiles "carries neither tag" as a negated group over the tag predicate', () => {
    const ast = parseODataFilter("not (tag eq 'fragile' or tag eq 'heavy')");
    expect(ast).toMatchObject({ logicalOperator: 'OR', negate: true });
    expect(ast.conditions).toHaveLength(2);
  });

  it('names the accepted property spellings when a field is unknown', () => {
    expect(() => parseODataFilter('bogus eq 1')).toThrow(/barcode/);
    expect(() => parseODataFilter('bogus eq 1')).toThrow(/tag/);
    // The published casing, not the lower-cased lookup key.
    expect(FILTERABLE_FIELD_NAMES).toContain('serialNumber');
  });

  it('refuses a prototype key rather than resolving it to a function', () => {
    // A plain-object map answers to `constructor`/`toString`/`__proto__`, which would hand the
    // translator a non-string field and fail as a 500 instead of this 400.
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(() => parseODataFilter(`${key} eq 'x'`)).toThrow(BadQueryError);
      expect(() => parseODataFilter(`${key} eq 'x'`)).toThrow(/Cannot filter/);
    }
  });
});

describe('parseODataFilter — rejected input', () => {
  const bad: [string, RegExp][] = [
    ['quantity ge 10', /not supported/],
    ['quantity le 10', /not supported/],
    ['bogus eq 1', /Cannot filter/],
    ['not', /Expected a field name or function/],
    ["startswith(name,'a')", /not supported/],
    ['quantity gt', /before a value|Expected a value/],
    ["name eq 'x' extra", /trailing input/],
    ["name eq 'x", /Unterminated/],
    ['', /must not be empty/],
    ['(name eq 1', /Expected/],
    ['name eq bareword', /Expected a value/],
  ];
  it.each(bad)('rejects %s', (input, message) => {
    expect(() => parseODataFilter(input)).toThrow(BadQueryError);
    expect(() => parseODataFilter(input)).toThrow(message);
  });
});
