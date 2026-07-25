import { describe, expect, it } from 'vitest';
import { parseASTtoSQL } from '@/db/search/parseASTtoSQL';
import type { FilterCondition, SearchAST } from '@/db/search/ast';
import { parseTextQuery } from './parse-text-query';

/**
 * Phase 47 — the §3 "hybrid text-based syntax" (e.g. `cap:voltage>3.3`). The parser
 * produces the *exact* {@link SearchAST} the Visual Builder edits, so every test
 * asserts the flat AND root group + leaf conditions, and the round-trip through the
 * real {@link parseASTtoSQL} (proving the output is always translatable).
 */

/** Narrow + assert a successful parse, returning the root condition list. */
function conditionsOf(input: string): readonly (SearchAST | FilterCondition)[] {
  const result = parseTextQuery(input);
  if (!result.ok) throw new Error(`expected ok parse, got error: ${result.error}`);
  expect(result.ast.type).toBe('GROUP');
  expect(result.ast.logicalOperator).toBe('AND');
  // The parser only ever emits a flat root group of leaf conditions.
  return result.ast.conditions;
}

/** The single leaf condition of a one-term query. */
function singleCondition(input: string): FilterCondition {
  const conditions = conditionsOf(input);
  expect(conditions).toHaveLength(1);
  return conditions[0] as FilterCondition;
}

describe('parseTextQuery — empty / whitespace', () => {
  it('returns an empty AND group for empty input', () => {
    const result = parseTextQuery('');
    expect(result).toEqual({ ok: true, ast: { type: 'GROUP', logicalOperator: 'AND', conditions: [] } });
  });

  it('returns an empty group for whitespace-only input', () => {
    expect(conditionsOf('   \t  ')).toHaveLength(0);
  });
});

describe('parseTextQuery — bare words → name CONTAINS', () => {
  it('maps a bare word to a name CONTAINS', () => {
    expect(singleCondition('esp32')).toEqual({ field: 'name', operator: 'CONTAINS', value: 'esp32' });
  });

  it('maps several bare words to several AND-ed name conditions', () => {
    const conditions = conditionsOf('blue widget');
    expect(conditions).toEqual([
      { field: 'name', operator: 'CONTAINS', value: 'blue' },
      { field: 'name', operator: 'CONTAINS', value: 'widget' },
    ]);
  });

  it('treats a double-quoted phrase as a single name CONTAINS', () => {
    expect(singleCondition('"esp 32 dev"')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'esp 32 dev',
    });
  });

  it('treats a single-quoted phrase as a single name CONTAINS', () => {
    expect(singleCondition("'blue widget'")).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'blue widget',
    });
  });

  it('ignores an empty quoted token', () => {
    expect(conditionsOf('""')).toHaveLength(0);
  });
});

describe('parseTextQuery — text fields', () => {
  it('field:value → CONTAINS', () => {
    expect(singleCondition('name:esp32')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'esp32',
    });
  });

  it('field=value → EQUALS', () => {
    expect(singleCondition('mpn=ABC-123')).toEqual({
      field: 'mpn',
      operator: 'EQUALS',
      value: 'ABC-123',
    });
  });

  it('resolves aliases (desc, mfr) to their canonical field', () => {
    expect(singleCondition('desc:driver')).toMatchObject({ field: 'description' });
    expect(singleCondition('mfr:acme')).toMatchObject({ field: 'manufacturer' });
  });

  it('is case-insensitive on the field name', () => {
    expect(singleCondition('NAME:esp')).toMatchObject({ field: 'name', operator: 'CONTAINS' });
  });

  it('keeps a quoted value with spaces intact', () => {
    expect(singleCondition('name:"esp 32"')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'esp 32',
    });
  });

  it('rejects > / < on a text field', () => {
    const result = parseTextQuery('name>esp');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/name/i);
  });

  it('rejects a field with a missing value', () => {
    const result = parseTextQuery('name:');
    expect(result.ok).toBe(false);
  });
});

describe('parseTextQuery — numeric field (quantity)', () => {
  it('quantity>10 → GREATER_THAN with a numeric value', () => {
    expect(singleCondition('quantity>10')).toEqual({
      field: 'quantity',
      operator: 'GREATER_THAN',
      value: 10,
    });
  });

  it('quantity<5 → LESS_THAN', () => {
    expect(singleCondition('quantity<5')).toMatchObject({ operator: 'LESS_THAN', value: 5 });
  });

  it('quantity=3 and quantity:3 → EQUALS', () => {
    expect(singleCondition('quantity=3')).toEqual({ field: 'quantity', operator: 'EQUALS', value: 3 });
    expect(singleCondition('quantity:3')).toEqual({ field: 'quantity', operator: 'EQUALS', value: 3 });
  });

  it('supports the qty alias and decimals', () => {
    expect(singleCondition('qty>2.5')).toEqual({ field: 'quantity', operator: 'GREATER_THAN', value: 2.5 });
  });

  it('rejects a non-numeric quantity value', () => {
    const result = parseTextQuery('quantity>lots');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/number/i);
  });
});

describe('parseTextQuery — boolean field (favourite, issue #23)', () => {
  it('favourite:yes → EQUALS true', () => {
    expect(singleCondition('favourite:yes')).toEqual({
      field: 'favourite',
      operator: 'EQUALS',
      value: true,
    });
  });

  it('favourite:no → EQUALS false', () => {
    expect(singleCondition('favourite:no')).toEqual({ field: 'favourite', operator: 'EQUALS', value: false });
  });

  it('accepts true/false/1/0/on/off and the = separator', () => {
    for (const q of ['favourite:true', 'favourite:1', 'favourite:on', 'favourite=yes']) {
      expect(singleCondition(q)).toMatchObject({ field: 'favourite', operator: 'EQUALS', value: true });
    }
    for (const q of ['favourite:false', 'favourite:0', 'favourite:off']) {
      expect(singleCondition(q)).toMatchObject({ field: 'favourite', operator: 'EQUALS', value: false });
    }
  });

  it('accepts the favorite (US) and fav aliases, canonicalising to favourite', () => {
    expect(singleCondition('favorite:yes')).toMatchObject({ field: 'favourite', value: true });
    expect(singleCondition('fav:no')).toMatchObject({ field: 'favourite', value: false });
  });

  it('rejects a non-boolean value and a >/< comparison', () => {
    for (const q of ['favourite:maybe', 'favourite>1']) {
      const result = parseTextQuery(q);
      expect(result.ok).toBe(false);
    }
  });
});

describe('parseTextQuery — lifecycle, valuation & policy fields (issue #140)', () => {
  it('reads a date term, with : meaning "on that day" and >/< after/before it', () => {
    expect(singleCondition('expiry<2026-03-01')).toEqual({
      field: 'expiry',
      operator: 'LESS_THAN',
      value: '2026-03-01',
    });
    expect(singleCondition('expiry>2026-03-01')).toMatchObject({ operator: 'GREATER_THAN' });
    expect(singleCondition('expiry:2026-03-01')).toMatchObject({ operator: 'EQUALS' });
    expect(singleCondition('warranty<2027-01-01')).toMatchObject({
      field: 'warranty',
      operator: 'LESS_THAN',
      value: '2027-01-01',
    });
  });

  it('rejects a date the SQL translator could not read, via the final gate', () => {
    // The date form is validated in one place; the parser surfaces that error verbatim.
    for (const q of ['expiry<01/03/2026', 'expiry:2026-02-31', 'warranty:soon']) {
      const result = parseTextQuery(q);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/YYYY-MM-DD/);
    }
  });

  it('reads an enum term through either separator, canonicalised to the stored spelling', () => {
    // The value is folded to the column's own spelling here, not just at translation time, so
    // the tree loaded into the Visual Builder matches that field's picker (a Select whose value
    // matches no option renders blank).
    expect(singleCondition('condition=needs-repair')).toEqual({
      field: 'condition',
      operator: 'EQUALS',
      value: 'NEEDS_REPAIR',
    });
    expect(singleCondition('condition:mint')).toMatchObject({ value: 'MINT' });
    expect(singleCondition('tracking:serialised')).toMatchObject({
      field: 'tracking',
      value: 'SERIALISED',
    });
    // The dead-stock vocabulary is lower-case; canonicalising must not upper-case it.
    expect(singleCondition('deadstock:ALWAYS')).toMatchObject({ field: 'deadstock', value: 'always' });
    // A multi-word spelling needs quoting only because the lexer splits on whitespace.
    expect(singleCondition('condition:"needs repair"')).toMatchObject({ value: 'NEEDS_REPAIR' });
  });

  it('leaves an unrecognised enum value alone, so the final gate names the vocabulary', () => {
    const result = parseTextQuery('condition:shabby');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/MINT, GOOD/);
  });

  it('rejects an ordering comparison and an unknown member on an enum field', () => {
    const compared = parseTextQuery('condition>MINT');
    expect(compared.ok).toBe(false);
    if (!compared.ok) expect(compared.error).toMatch(/fixed set of values/);

    const unknown = parseTextQuery('condition:shabby');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/MINT, GOOD/);
  });

  it('reads money in major units, leaving the micro-unit scaling to the SQL layer', () => {
    expect(singleCondition('cost>10')).toEqual({ field: 'cost', operator: 'GREATER_THAN', value: 10 });
    expect(singleCondition('price<2.5')).toMatchObject({ field: 'price', value: 2.5 });
    expect(singleCondition('value=99.99')).toMatchObject({ field: 'value', value: 99.99 });
    expect(
      parseASTtoSQL({ type: 'GROUP', logicalOperator: 'AND', conditions: [singleCondition('cost>10')] }),
    ).toEqual(['(items.unit_cost > ?)', [10_000_000]]);
  });

  it('accepts the aliases for each new field', () => {
    expect(singleCondition('cond:mint')).toMatchObject({ field: 'condition' });
    expect(singleCondition('unitcost>1')).toMatchObject({ field: 'cost' });
    expect(singleCondition('purchaseprice>1')).toMatchObject({ field: 'price' });
    expect(singleCondition('worth>1')).toMatchObject({ field: 'value' });
    expect(singleCondition('expires<2026-03-01')).toMatchObject({ field: 'expiry' });
    expect(singleCondition('reorderpoint>0')).toMatchObject({ field: 'reorder' });
    expect(singleCondition('trackingmode:discrete')).toMatchObject({ field: 'tracking' });
  });

  it('reads the active flag as a yes/no, like favourite', () => {
    expect(singleCondition('active:no')).toEqual({ field: 'active', operator: 'EQUALS', value: false });
    expect(singleCondition('active:yes')).toMatchObject({ value: true });
  });

  it('reports a missing value rather than silently dropping the term', () => {
    for (const q of ['expiry:', 'condition:', 'cost>']) {
      expect(parseTextQuery(q).ok).toBe(false);
    }
  });

  it("treats a prefix inherited from the alias table's prototype as a plain name search", () => {
    // A bare index would return `Object.prototype.constructor` — a truthy "alias" with no kind.
    for (const prefix of ['constructor', 'toString', 'valueOf']) {
      expect(singleCondition(`${prefix}:foo`)).toEqual({
        field: 'name',
        operator: 'CONTAINS',
        value: `${prefix}:foo`,
      });
    }
  });
});

describe('parseTextQuery — tags (issue #138)', () => {
  it('tag:<name> → a tag CONTAINS on the name', () => {
    expect(singleCondition('tag:expo')).toEqual({ field: 'tag', operator: 'CONTAINS', value: 'expo' });
  });

  it('tag=<name> → a whole-name EQUALS', () => {
    expect(singleCondition('tag=fragile')).toEqual({ field: 'tag', operator: 'EQUALS', value: 'fragile' });
  });

  it('accepts the tags / tagged aliases and is case-insensitive on the prefix', () => {
    for (const q of ['tags:expo', 'tagged:expo', 'TAG:expo']) {
      expect(singleCondition(q)).toMatchObject({ field: 'tag', operator: 'CONTAINS', value: 'expo' });
    }
  });

  it('keeps a quoted multi-word tag name intact', () => {
    expect(singleCondition('tag:"needs a clean"')).toEqual({
      field: 'tag',
      operator: 'CONTAINS',
      value: 'needs a clean',
    });
  });

  it('keeps a hyphenated tag name whole', () => {
    expect(singleCondition('tag=expo-2026')).toEqual({
      field: 'tag',
      operator: 'EQUALS',
      value: 'expo-2026',
    });
  });

  it('rejects > / < on a tag name, and a missing name', () => {
    for (const q of ['tag>3', 'tag:']) {
      expect(parseTextQuery(q).ok).toBe(false);
    }
  });

  it('combines with other terms and with OR groups', () => {
    const conditions = conditionsOf('tag:fragile qty<10');
    expect(conditions).toEqual([
      { field: 'tag', operator: 'CONTAINS', value: 'fragile' },
      { field: 'quantity', operator: 'LESS_THAN', value: 10 },
    ]);
  });
});

describe('parseTextQuery — capabilities', () => {
  it('cap:<key> with no operator → HAS_CAPABILITY', () => {
    expect(singleCondition('cap:rohs')).toEqual({
      field: 'capability:rohs',
      operator: 'HAS_CAPABILITY',
      value: '',
    });
  });

  it('cap:<key>>n → GREATER_THAN numeric', () => {
    expect(singleCondition('cap:voltage>3.3')).toEqual({
      field: 'capability:voltage',
      operator: 'GREATER_THAN',
      value: 3.3,
    });
  });

  it('cap:<key><n → LESS_THAN numeric', () => {
    expect(singleCondition('cap:tolerance<1')).toMatchObject({
      field: 'capability:tolerance',
      operator: 'LESS_THAN',
      value: 1,
    });
  });

  it('cap:<key>=n → numeric EQUALS', () => {
    expect(singleCondition('cap:pins=40')).toEqual({
      field: 'capability:pins',
      operator: 'EQUALS',
      value: 40,
    });
  });

  it('cap:<key>=text → text EQUALS', () => {
    expect(singleCondition('cap:material=fr4')).toEqual({
      field: 'capability:material',
      operator: 'EQUALS',
      value: 'fr4',
    });
  });

  it('accepts the long capability alias', () => {
    expect(singleCondition('capability:voltage>5')).toMatchObject({ field: 'capability:voltage' });
  });

  it('rejects cap: with an empty key', () => {
    const result = parseTextQuery('cap:');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric comparison value', () => {
    const result = parseTextQuery('cap:voltage>high');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/number/i);
  });
});

describe('parseTextQuery — custom fields (Phase 71)', () => {
  it('field:<name> with no operator → presence (HAS_CAPABILITY)', () => {
    expect(singleCondition('field:Datasheet')).toEqual({
      field: 'field:Datasheet',
      operator: 'HAS_CAPABILITY',
      value: '',
    });
  });

  it('field:<name>:value → text CONTAINS', () => {
    expect(singleCondition('field:Notes:rev2')).toEqual({
      field: 'field:Notes',
      operator: 'CONTAINS',
      value: 'rev2',
    });
  });

  it('field:<name>=text → text EQUALS', () => {
    expect(singleCondition('field:Colour=red')).toEqual({
      field: 'field:Colour',
      operator: 'EQUALS',
      value: 'red',
    });
  });

  it('field:<name>=n → numeric EQUALS', () => {
    expect(singleCondition('field:Rating=5')).toEqual({
      field: 'field:Rating',
      operator: 'EQUALS',
      value: 5,
    });
  });

  it('field:<name>>n → GREATER_THAN numeric', () => {
    expect(singleCondition('field:Rating>3.3')).toEqual({
      field: 'field:Rating',
      operator: 'GREATER_THAN',
      value: 3.3,
    });
  });

  it('field:<name><n → LESS_THAN numeric', () => {
    expect(singleCondition('field:Rating<1')).toMatchObject({
      field: 'field:Rating',
      operator: 'LESS_THAN',
      value: 1,
    });
  });

  it('accepts the cf: alias', () => {
    expect(singleCondition('cf:Notes:x')).toEqual({
      field: 'field:Notes',
      operator: 'CONTAINS',
      value: 'x',
    });
  });

  it('rejects field: with an empty name', () => {
    const result = parseTextQuery('field:');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric comparison value', () => {
    const result = parseTextQuery('field:Rating>high');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/number/i);
  });
});

describe('parseTextQuery — composite queries (the spec example)', () => {
  it('parses `cap:voltage>3.3 quantity<10` into two AND-ed conditions', () => {
    const conditions = conditionsOf('cap:voltage>3.3 quantity<10');
    expect(conditions).toEqual([
      { field: 'capability:voltage', operator: 'GREATER_THAN', value: 3.3 },
      { field: 'quantity', operator: 'LESS_THAN', value: 10 },
    ]);
  });

  it('mixes bare words and field terms', () => {
    const conditions = conditionsOf('esp32 mfr:espressif quantity>0');
    expect(conditions).toEqual([
      { field: 'name', operator: 'CONTAINS', value: 'esp32' },
      { field: 'manufacturer', operator: 'CONTAINS', value: 'espressif' },
      { field: 'quantity', operator: 'GREATER_THAN', value: 0 },
    ]);
  });
});

describe('parseTextQuery — OR / parentheses (grammar depth, Phase 48)', () => {
  /** Narrow + assert a successful parse, returning the whole root group. */
  function rootOf(input: string): SearchAST {
    const result = parseTextQuery(input);
    if (!result.ok) throw new Error(`expected ok parse, got error: ${result.error}`);
    return result.ast;
  }

  it('a OR b → a top-level OR group of two name conditions', () => {
    const root = rootOf('blue OR widget');
    expect(root.logicalOperator).toBe('OR');
    expect(root.conditions).toEqual([
      { field: 'name', operator: 'CONTAINS', value: 'blue' },
      { field: 'name', operator: 'CONTAINS', value: 'widget' },
    ]);
  });

  it('treats | as OR', () => {
    expect(rootOf('blue|widget').logicalOperator).toBe('OR');
  });

  it('is case-insensitive on the OR keyword', () => {
    expect(rootOf('blue or widget').logicalOperator).toBe('OR');
  });

  it('binds AND tighter than OR (a OR b c → a OR (b AND c))', () => {
    const root = rootOf('qty<10 OR mfr:acme cap:rohs');
    expect(root.logicalOperator).toBe('OR');
    expect(root.conditions).toHaveLength(2);
    expect(root.conditions[0]).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 10 });
    const second = root.conditions[1] as SearchAST;
    expect(second.type).toBe('GROUP');
    expect(second.logicalOperator).toBe('AND');
    expect(second.conditions).toEqual([
      { field: 'manufacturer', operator: 'CONTAINS', value: 'acme' },
      { field: 'capability:rohs', operator: 'HAS_CAPABILITY', value: '' },
    ]);
  });

  it('parentheses override precedence ((a OR b) c → AND of an OR group and a leaf)', () => {
    const root = rootOf('(qty<10 OR mfr:acme) cap:rohs');
    expect(root.logicalOperator).toBe('AND');
    expect(root.conditions).toHaveLength(2);
    const first = root.conditions[0] as SearchAST;
    expect(first.type).toBe('GROUP');
    expect(first.logicalOperator).toBe('OR');
    expect(root.conditions[1]).toMatchObject({ field: 'capability:rohs' });
  });

  it('treats an explicit AND keyword like juxtaposition', () => {
    const root = rootOf('blue AND widget');
    expect(root.logicalOperator).toBe('AND');
    expect(root.conditions).toEqual([
      { field: 'name', operator: 'CONTAINS', value: 'blue' },
      { field: 'name', operator: 'CONTAINS', value: 'widget' },
    ]);
  });

  it('flattens redundant brackets to a single condition', () => {
    const root = rootOf('((esp32))');
    expect(root).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      conditions: [{ field: 'name', operator: 'CONTAINS', value: 'esp32' }],
    });
  });

  it('keeps a bracket inside a quoted value literal', () => {
    const root = rootOf('name:"a (b)"');
    expect(root.conditions).toEqual([{ field: 'name', operator: 'CONTAINS', value: 'a (b)' }]);
  });

  it('ignores an empty group, an empty query still matches everything', () => {
    expect(rootOf('esp32 ()').conditions).toEqual([{ field: 'name', operator: 'CONTAINS', value: 'esp32' }]);
    expect(rootOf('()').conditions).toHaveLength(0);
  });

  it('rejects an unmatched opening parenthesis', () => {
    const result = parseTextQuery('(qty<10 OR mfr:acme');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\(/);
  });

  it('rejects an unmatched closing parenthesis', () => {
    const result = parseTextQuery('qty<10) esp32');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\)/);
  });

  it('rejects a tree nested past the §5.1 depth cap', () => {
    // Genuine branching nesting (flattening cannot collapse it): root + 4 OR groups → depth 5.
    const result = parseTextQuery('(a OR (b OR (c OR (d OR (e OR f)))))');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/deep|nested/i);
  });

  it('surfaces a leaf error from inside a group', () => {
    const result = parseTextQuery('(name:ok OR quantity>lots)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/number/i);
  });
});

describe('parseTextQuery — negation (issue #139)', () => {
  /** Narrow + assert a successful parse, returning the whole root group. */
  function rootOf(input: string): SearchAST {
    const result = parseTextQuery(input);
    if (!result.ok) throw new Error(`expected ok parse, got error: ${result.error}`);
    return result.ast;
  }

  it('-term wraps the single condition in a negated group', () => {
    expect(rootOf('-mfr:acme')).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      negate: true,
      conditions: [{ field: 'manufacturer', operator: 'CONTAINS', value: 'acme' }],
    });
  });

  it('accepts the NOT keyword in any case as the same form', () => {
    for (const q of ['NOT mfr:acme', 'not mfr:acme', 'Not mfr:acme']) {
      expect(rootOf(q)).toEqual(rootOf('-mfr:acme'));
    }
  });

  it('negates a whole bracketed group in place, without an extra wrapper', () => {
    expect(rootOf('-(blue OR widget)')).toEqual({
      type: 'GROUP',
      logicalOperator: 'OR',
      negate: true,
      conditions: [
        { field: 'name', operator: 'CONTAINS', value: 'blue' },
        { field: 'name', operator: 'CONTAINS', value: 'widget' },
      ],
    });
  });

  it('binds to one factor, so "-a b" is "(not a) and b"', () => {
    const root = rootOf('-mfr:acme esp32');
    expect(root.logicalOperator).toBe('AND');
    expect(root.negate).toBeUndefined();
    expect(root.conditions).toEqual([
      {
        type: 'GROUP',
        logicalOperator: 'AND',
        negate: true,
        conditions: [{ field: 'manufacturer', operator: 'CONTAINS', value: 'acme' }],
      },
      { field: 'name', operator: 'CONTAINS', value: 'esp32' },
    ]);
  });

  it('cancels a double negation back to the plain group', () => {
    expect(rootOf('--esp32')).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      conditions: [{ field: 'name', operator: 'CONTAINS', value: 'esp32' }],
    });
  });

  it('writes "not equal to" as a negated EQUALS', () => {
    expect(rootOf('-mpn=ABC-123')).toEqual({
      type: 'GROUP',
      logicalOperator: 'AND',
      negate: true,
      conditions: [{ field: 'mpn', operator: 'EQUALS', value: 'ABC-123' }],
    });
  });

  it('leaves a hyphen inside a term, a value or a quoted phrase literal', () => {
    expect(rootOf('mpn:ABC-123').conditions).toEqual([
      { field: 'mpn', operator: 'CONTAINS', value: 'ABC-123' },
    ]);
    expect(rootOf('qty>-1').conditions).toEqual([{ field: 'quantity', operator: 'GREATER_THAN', value: -1 }]);
    expect(rootOf('"-40C"').conditions).toEqual([{ field: 'name', operator: 'CONTAINS', value: '-40C' }]);
  });

  it('leaves a dangling or standalone hyphen as an ordinary word', () => {
    expect(rootOf('esp32 -').conditions).toEqual([
      { field: 'name', operator: 'CONTAINS', value: 'esp32' },
      { field: 'name', operator: 'CONTAINS', value: '-' },
    ]);
  });

  it('ignores a negated empty group rather than inverting "everything"', () => {
    expect(rootOf('esp32 -()').conditions).toEqual([{ field: 'name', operator: 'CONTAINS', value: 'esp32' }]);
  });

  it('rejects a NOT with nothing to negate', () => {
    for (const q of ['NOT', 'esp32 NOT', 'NOT OR esp32']) {
      const result = parseTextQuery(q);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/NOT/);
    }
  });
});

describe('parseTextQuery — presence (has:, issue #139)', () => {
  it('has:<field> → presence on the scalar column', () => {
    expect(singleCondition('has:mpn')).toEqual({ field: 'mpn', operator: 'HAS_CAPABILITY', value: '' });
  });

  it('accepts the same short aliases the comparison forms do', () => {
    expect(singleCondition('has:mfr')).toMatchObject({ field: 'manufacturer' });
    expect(singleCondition('has:sn')).toMatchObject({ field: 'serial' });
    expect(singleCondition('have:desc')).toMatchObject({ field: 'description' });
  });

  it('answers "anything without a category" when negated', () => {
    const result = parseTextQuery('-has:category');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ast).toEqual({
        type: 'GROUP',
        logicalOperator: 'AND',
        negate: true,
        conditions: [{ field: 'category', operator: 'HAS_CAPABILITY', value: '' }],
      });
    }
  });

  it('reads an unknown name as a category custom field', () => {
    expect(singleCondition('has:Datasheet')).toEqual({
      field: 'field:Datasheet',
      operator: 'HAS_CAPABILITY',
      value: '',
    });
    expect(singleCondition('has:"Voltage rating"')).toMatchObject({ field: 'field:Voltage rating' });
  });

  it('rejects a field every item always has, rather than matching everything', () => {
    for (const q of ['has:name', 'has:qty', 'has:location', 'has:fav']) {
      const result = parseTextQuery(q);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/every item/i);
    }
  });

  it('rejects has: with no field', () => {
    const result = parseTextQuery('has:');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/needs a field/i);
  });
});

describe('parseTextQuery — every output round-trips through parseASTtoSQL', () => {
  const queries = [
    'esp32',
    '-esp32',
    'NOT mfr:acme',
    '-(qty<10 OR mfr:acme)',
    'esp32 -has:Datasheet',
    '-has:category',
    'has:mpn',
    'name:"esp 32"',
    'mpn=ABC-123',
    'quantity>10',
    'qty<5',
    'cap:rohs',
    'cap:voltage>3.3',
    'cap:material=fr4',
    'cap:voltage>3.3 quantity<10 esp32',
    'field:Datasheet',
    'field:Notes:rev2',
    'field:Rating>3.3',
    'field:Notes:rev2 OR cap:rohs',
    'tag:expo',
    'tag=expo-2026 (qty<10 OR fav:yes)',
    'blue OR widget',
    'cap:voltage>3.3 (qty<10 OR mfr:acme)',
    '(a OR (b OR (c OR (d OR e))))',
    '',
  ];
  for (const q of queries) {
    it(`translates "${q}" to SQL without throwing`, () => {
      const result = parseTextQuery(q);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const [sql, params] = parseASTtoSQL(result.ast);
        expect(typeof sql).toBe('string');
        expect(Array.isArray(params)).toBe(true);
      }
    });
  }
});
