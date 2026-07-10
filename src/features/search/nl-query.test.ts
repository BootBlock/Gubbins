import { describe, expect, it } from 'vitest';
import { parseASTtoSQL } from '@/db/search/parseASTtoSQL';
import type { FilterCondition, SearchAST } from '@/db/search/ast';
import { NL_LOW_STOCK_FALLBACK_QTY, interpretNaturalLanguage, type NlContext } from './nl-query';

/**
 * Feature-gap G5 — the rule-based, no-LLM natural-language → SearchAST layer. Every
 * test asserts the flat AND root group of leaf conditions it emits, and (via
 * {@link expectTranslatable}) that the tree round-trips through the real
 * {@link parseASTtoSQL} — proving the output is always a tree the SQL translator accepts.
 */

const GARAGE = { id: 'loc-garage', name: 'Garage' };
const SHELF_2 = { id: 'loc-shelf-2', name: 'Shelf 2' };
const TOP_DRAWER = { id: 'loc-top-drawer', name: 'Top Drawer' };
const CAT_RESISTORS = { id: 'cat-res', name: 'Resistors' };
const CAT_POWER_TOOLS = { id: 'cat-pt', name: 'Power Tools' };

const CONTEXT: NlContext = {
  locations: [GARAGE, SHELF_2, TOP_DRAWER],
  categories: [CAT_RESISTORS, CAT_POWER_TOOLS],
  lowStockQtyThreshold: 5,
};

/** Interpret and return the flat root condition list, asserting the shape + translatability. */
function conditionsOf(
  phrase: string,
  context: NlContext = CONTEXT,
): readonly (SearchAST | FilterCondition)[] {
  const result = interpretNaturalLanguage(phrase, context);
  expect(result.ast.type).toBe('GROUP');
  expect(result.ast.logicalOperator).toBe('AND');
  expectTranslatable(result.ast);
  return result.ast.conditions;
}

/** The single leaf condition of a one-intent phrase. */
function singleCondition(phrase: string, context: NlContext = CONTEXT): FilterCondition {
  const conditions = conditionsOf(phrase, context);
  expect(conditions).toHaveLength(1);
  return conditions[0] as FilterCondition;
}

/** Assert the AST is accepted by the single SQL translator (never throws). */
function expectTranslatable(ast: SearchAST): void {
  expect(() => parseASTtoSQL(ast)).not.toThrow();
}

describe('interpretNaturalLanguage — empty / unrecognised', () => {
  it('returns the empty match-everything tree for an empty phrase', () => {
    const result = interpretNaturalLanguage('', CONTEXT);
    expect(result.empty).toBe(true);
    expect(result.ast).toEqual({ type: 'GROUP', logicalOperator: 'AND', conditions: [] });
    expect(result.recognised).toEqual([]);
  });

  it('returns empty for a whitespace / punctuation-only phrase', () => {
    expect(interpretNaturalLanguage('   ...  ', CONTEXT).empty).toBe(true);
  });

  it('drops filler-only phrases to empty', () => {
    expect(interpretNaturalLanguage('show me all of the items please', CONTEXT).empty).toBe(true);
  });
});

describe('interpretNaturalLanguage — residual free text → name CONTAINS', () => {
  it('maps leftover words to a single name CONTAINS', () => {
    expect(singleCondition('screwdriver')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'screwdriver',
    });
  });

  it('joins several leftover words into one name CONTAINS, stripping filler', () => {
    expect(singleCondition('show me all blue widgets')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'blue widgets',
    });
  });

  it('strips punctuation from the text value', () => {
    expect(singleCondition('esp32!')).toEqual({ field: 'name', operator: 'CONTAINS', value: 'esp32' });
  });
});

describe('interpretNaturalLanguage — stock level', () => {
  it('maps "out of stock" to quantity = 0', () => {
    expect(singleCondition('out of stock')).toEqual({ field: 'quantity', operator: 'EQUALS', value: 0 });
  });

  it.each(['none left', 'sold out', 'no stock', 'nothing left', 'none in stock'])(
    'maps "%s" to quantity = 0',
    (phrase) => {
      expect(singleCondition(phrase)).toEqual({ field: 'quantity', operator: 'EQUALS', value: 0 });
    },
  );

  it('maps "low stock" to quantity < threshold', () => {
    expect(singleCondition('low stock')).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 5 });
  });

  it.each(['running low', 'getting low', 'nearly out', 'almost out', 'low on stock'])(
    'maps "%s" to quantity < threshold',
    (phrase) => {
      expect(singleCondition(phrase)).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 5 });
    },
  );

  it.each(['in stock', 'on hand', 'available', 'any left'])('maps "%s" to quantity > 0', (phrase) => {
    expect(singleCondition(phrase)).toEqual({ field: 'quantity', operator: 'GREATER_THAN', value: 0 });
  });

  it('uses the caller low-stock threshold', () => {
    const condition = singleCondition('low stock', { lowStockQtyThreshold: 12 });
    expect(condition).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 12 });
  });

  it('falls back to the NL floor when the low-stock preference is off (0)', () => {
    const condition = singleCondition('low stock', { lowStockQtyThreshold: 0 });
    expect(condition).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: NL_LOW_STOCK_FALLBACK_QTY });
  });

  it('falls back to the NL floor when no threshold is supplied', () => {
    const condition = singleCondition('low stock', {});
    expect(condition).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: NL_LOW_STOCK_FALLBACK_QTY });
  });

  it('floors a fractional threshold', () => {
    const condition = singleCondition('low stock', { lowStockQtyThreshold: 7.9 });
    expect(condition).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 7 });
  });

  it('labels low stock with the effective threshold', () => {
    const result = interpretNaturalLanguage('low stock', { lowStockQtyThreshold: 8 });
    expect(result.recognised).toEqual([{ kind: 'stock', label: 'Low stock (under 8)' }]);
  });
});

describe('interpretNaturalLanguage — quantity comparisons', () => {
  it('maps "more than 10" to quantity > 10', () => {
    expect(singleCondition('more than 10')).toEqual({
      field: 'quantity',
      operator: 'GREATER_THAN',
      value: 10,
    });
  });

  it.each([
    ['over 10', 'GREATER_THAN', 10],
    ['above 3', 'GREATER_THAN', 3],
    ['greater than 7', 'GREATER_THAN', 7],
    ['fewer than 5', 'LESS_THAN', 5],
    ['less than 5', 'LESS_THAN', 5],
    ['under 2', 'LESS_THAN', 2],
    ['below 9', 'LESS_THAN', 9],
    ['exactly 3', 'EQUALS', 3],
    ['equal to 4', 'EQUALS', 4],
  ] as const)('maps "%s" to quantity %s %d', (phrase, operator, value) => {
    expect(singleCondition(phrase)).toEqual({ field: 'quantity', operator, value });
  });

  it('maps inclusive "at least 10" to quantity > 9 (≥ 10 on integers)', () => {
    expect(singleCondition('at least 10')).toEqual({ field: 'quantity', operator: 'GREATER_THAN', value: 9 });
  });

  it('maps inclusive "at most 10" to quantity < 11 (≤ 10 on integers)', () => {
    expect(singleCondition('at most 10')).toEqual({ field: 'quantity', operator: 'LESS_THAN', value: 11 });
  });

  it.each([
    ['10 or more', 'GREATER_THAN', 9],
    ['5 or fewer', 'LESS_THAN', 6],
    ['5 or less', 'LESS_THAN', 6],
  ] as const)('maps "%s" to quantity %s %d', (phrase, operator, value) => {
    expect(singleCondition(phrase)).toEqual({ field: 'quantity', operator, value });
  });

  it('maps "5 in stock" to quantity = 5 (not the bare "in stock")', () => {
    expect(singleCondition('5 in stock')).toEqual({ field: 'quantity', operator: 'EQUALS', value: 5 });
  });

  it('understands spelled-out numbers', () => {
    expect(singleCondition('more than twenty')).toEqual({
      field: 'quantity',
      operator: 'GREATER_THAN',
      value: 20,
    });
  });

  it('leaves a comparison with no number as plain text', () => {
    // "more than" with nothing numeric after it isn't a quantity intent — the words fall
    // through to the residual text search.
    expect(singleCondition('more than widgets')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'more than widgets',
    });
  });
});

describe('interpretNaturalLanguage — location phrases', () => {
  it('resolves "in the garage" to a location EQUALS id', () => {
    expect(singleCondition('in the garage')).toEqual({
      field: 'location',
      operator: 'EQUALS',
      value: 'loc-garage',
    });
  });

  it.each(['in garage', 'at the garage', 'inside the garage', 'from garage'])(
    'resolves "%s" via various prepositions/determiners',
    (phrase) => {
      expect(singleCondition(phrase)).toEqual({ field: 'location', operator: 'EQUALS', value: 'loc-garage' });
    },
  );

  it('resolves a multi-word location name ("on shelf 2")', () => {
    expect(singleCondition('on shelf 2')).toEqual({
      field: 'location',
      operator: 'EQUALS',
      value: 'loc-shelf-2',
    });
  });

  it('prefers the longest location name', () => {
    expect(singleCondition('in the top drawer')).toEqual({
      field: 'location',
      operator: 'EQUALS',
      value: 'loc-top-drawer',
    });
  });

  it('matches a location whose name begins with a determiner ("The Shed")', () => {
    const context: NlContext = { locations: [{ id: 'loc-shed', name: 'The Shed' }] };
    expect(singleCondition('in the shed', context)).toEqual({
      field: 'location',
      operator: 'EQUALS',
      value: 'loc-shed',
    });
  });

  it('leaves an unknown location as residual text', () => {
    expect(singleCondition('in the attic')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'attic',
    });
  });

  it('emits at most one location', () => {
    const conditions = conditionsOf('in the garage in shelf 2');
    const locations = conditions.filter((c): c is FilterCondition => 'field' in c && c.field === 'location');
    expect(locations).toHaveLength(1);
  });
});

describe('interpretNaturalLanguage — category mentions', () => {
  it('resolves a category name to a category EQUALS id', () => {
    const conditions = conditionsOf('resistors');
    expect(conditions).toContainEqual({ field: 'category', operator: 'EQUALS', value: 'cat-res' });
  });

  it('resolves a multi-word category ("power tools")', () => {
    const conditions = conditionsOf('power tools');
    expect(conditions).toEqual([{ field: 'category', operator: 'EQUALS', value: 'cat-pt' }]);
  });

  it('does not treat an unknown word as a category', () => {
    expect(singleCondition('capacitors')).toEqual({
      field: 'name',
      operator: 'CONTAINS',
      value: 'capacitors',
    });
  });
});

describe('interpretNaturalLanguage — combined intents', () => {
  it('interprets the headline example "low stock screws in the garage"', () => {
    const result = interpretNaturalLanguage('low stock screws in the garage', CONTEXT);
    expect(result.empty).toBe(false);
    expect(result.ast.conditions).toEqual([
      { field: 'quantity', operator: 'LESS_THAN', value: 5 },
      { field: 'location', operator: 'EQUALS', value: 'loc-garage' },
      { field: 'name', operator: 'CONTAINS', value: 'screws' },
    ]);
    expect(result.recognised.map((r) => r.kind)).toEqual(['stock', 'location', 'text']);
  });

  it('combines a quantity comparison, a category and residual text', () => {
    const result = interpretNaturalLanguage('resistors with more than 100 in stock', CONTEXT);
    expect(result.ast.conditions).toEqual([
      { field: 'quantity', operator: 'GREATER_THAN', value: 100 },
      { field: 'category', operator: 'EQUALS', value: 'cat-res' },
    ]);
  });

  it('orders conditions quantity/stock → location → category → text', () => {
    const result = interpretNaturalLanguage('out of stock power tools in the garage', CONTEXT);
    expect(result.ast.conditions).toEqual([
      { field: 'quantity', operator: 'EQUALS', value: 0 },
      { field: 'location', operator: 'EQUALS', value: 'loc-garage' },
      { field: 'category', operator: 'EQUALS', value: 'cat-pt' },
    ]);
    expectTranslatable(result.ast);
  });
});

describe('interpretNaturalLanguage — robustness', () => {
  it('is case-insensitive', () => {
    const result = interpretNaturalLanguage('LOW STOCK IN THE GARAGE', CONTEXT);
    expect(result.ast.conditions).toEqual([
      { field: 'quantity', operator: 'LESS_THAN', value: 5 },
      { field: 'location', operator: 'EQUALS', value: 'loc-garage' },
    ]);
  });

  it('works with no resolver context (locations/categories omitted)', () => {
    const result = interpretNaturalLanguage('low stock widgets', {});
    expect(result.ast.conditions).toEqual([
      { field: 'quantity', operator: 'LESS_THAN', value: NL_LOW_STOCK_FALLBACK_QTY },
      { field: 'name', operator: 'CONTAINS', value: 'widgets' },
    ]);
  });

  it('ignores empty-named resolver entries without throwing', () => {
    const result = interpretNaturalLanguage('widgets', {
      locations: [{ id: 'x', name: '   ' }],
      categories: [{ id: 'y', name: '' }],
    });
    expect(result.ast.conditions).toEqual([{ field: 'name', operator: 'CONTAINS', value: 'widgets' }]);
  });

  it('every recognised part corresponds to a condition', () => {
    const result = interpretNaturalLanguage('low stock resistors in the garage', CONTEXT);
    expect(result.recognised).toHaveLength(result.ast.conditions.length);
  });
});
