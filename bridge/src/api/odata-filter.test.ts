/**
 * Unit tests for the constrained OData `$filter` → SearchAST compiler. Pure (no DB): they
 * assert the produced AST shape for the supported grammar and a {@link BadQueryError} for
 * everything outside the subset.
 */
import { describe, expect, it } from 'vitest';
import { FIELD_MAP, FILTERABLE_PROPERTIES, parseODataFilter } from './odata-filter.ts';
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

  it('compiles the contains() function to CONTAINS', () => {
    expect(parseODataFilter("contains(name,'bolt')").conditions[0]).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'bolt',
    });
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
      conditions: [{ field: 'name', operator: 'CONTAINS', value: 'bolt' }],
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

describe('FILTERABLE_PROPERTIES (the metadata document reads this)', () => {
  // The CSDL states filterability as the *complement* of this list, so an entry that isn't
  // really filterable tells a client to push down a filter that will 400 mid-refresh, and a
  // filterable field left out tells it to evaluate client-side what the service could have done.
  it('names only properties the parser actually accepts', () => {
    for (const property of FILTERABLE_PROPERTIES) {
      expect(() => parseODataFilter(`contains(${property},'x')`)).not.toThrow();
    }
  });

  it('covers every field the parser can filter on (no filterable field left undeclared)', () => {
    const declared = new Set(FILTERABLE_PROPERTIES.map((name) => FIELD_MAP[name.toLowerCase()]));
    expect([...declared].sort()).toEqual([...new Set(Object.values(FIELD_MAP))].sort());
  });
});
