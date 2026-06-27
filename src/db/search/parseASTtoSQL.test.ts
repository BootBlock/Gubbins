import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { MAX_AST_GROUP_DEPTH, type ASTGroupNode, type FilterCondition } from './ast';
import { parseASTtoSQL, SearchAstError } from './parseASTtoSQL';

/** Wrap conditions in a root AND group for brevity. */
function and(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'AND', conditions };
}
function or(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'OR', conditions };
}

describe('parseASTtoSQL — structure & parameterisation (spec §5.1)', () => {
  it('returns match-all for an empty tree', () => {
    expect(parseASTtoSQL(and())).toEqual(['1', []]);
  });

  it('translates a case-insensitive text EQUALS with a bound parameter', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'manufacturer', operator: 'EQUALS', value: 'TI' }),
    );
    expect(sql).toBe('(items.manufacturer = ? COLLATE NOCASE)');
    expect(params).toEqual(['TI']);
  });

  it('translates numeric comparisons', () => {
    expect(parseASTtoSQL(and({ field: 'quantity', operator: 'GREATER_THAN', value: 10 }))).toEqual([
      '(items.quantity > ?)',
      [10],
    ]);
    expect(parseASTtoSQL(and({ field: 'quantity', operator: 'LESS_THAN', value: 5 }))).toEqual([
      '(items.quantity < ?)',
      [5],
    ]);
  });

  it('routes free-text CONTAINS through the FTS5 index, scoped to the column', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'description', operator: 'CONTAINS', value: 'voltage reg' }),
    );
    expect(sql).toBe('(items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?))');
    expect(params).toEqual(['description : ("voltage"* "reg"*)']);
  });

  it('never concatenates values into the SQL text (only ? placeholders)', () => {
    const [sql, params] = parseASTtoSQL(
      and(
        { field: 'name', operator: 'EQUALS', value: "Bobby'); DROP TABLE items;--" },
        { field: 'quantity', operator: 'GREATER_THAN', value: 99 },
      ),
    );
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('99');
    expect(params).toEqual(["Bobby'); DROP TABLE items;--", 99]);
  });

  it('combines siblings with the group operator and parenthesises nested groups', () => {
    const [sql] = parseASTtoSQL(
      and(
        { field: 'category', operator: 'EQUALS', value: 'cat-1' },
        or(
          { field: 'quantity', operator: 'LESS_THAN', value: 5 },
          { field: 'manufacturer', operator: 'EQUALS', value: 'TI' },
        ),
      ),
    );
    expect(sql).toBe(
      '(items.category_id = ? COLLATE NOCASE AND (items.quantity < ? OR items.manufacturer = ? COLLATE NOCASE))',
    );
  });

  it('drops empty groups instead of degenerating an OR into match-all', () => {
    const [sql, params] = parseASTtoSQL(
      or({ field: 'quantity', operator: 'GREATER_THAN', value: 1 }, and()),
    );
    expect(sql).toBe('(items.quantity > ?)');
    expect(params).toEqual([1]);
  });
});

describe('parseASTtoSQL — capabilities (spec §4 Weighted Capabilities)', () => {
  it('translates HAS_CAPABILITY to an EXISTS over the capabilities table', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'capability:voltage', operator: 'HAS_CAPABILITY', value: true }),
    );
    expect(sql).toBe(
      '(EXISTS (SELECT 1 FROM capabilities c WHERE c.item_id = items.id AND c.key = ? COLLATE NOCASE))',
    );
    expect(params).toEqual(['voltage']);
  });

  it('translates a numeric capability comparison binding key then value', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'capability:voltage', operator: 'GREATER_THAN', value: 3.3 }),
    );
    expect(sql).toContain('AND c.value_num > ?');
    expect(params).toEqual(['voltage', 3.3]);
  });

  it('translates a text capability EQUALS against value_text', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'capability:package', operator: 'EQUALS', value: 'SMD' }),
    );
    expect(sql).toContain('AND c.value_text = ? COLLATE NOCASE');
    expect(params).toEqual(['package', 'SMD']);
  });

  it('rejects a capability field with no key', () => {
    expect(() =>
      parseASTtoSQL(and({ field: 'capability:', operator: 'HAS_CAPABILITY', value: true })),
    ).toThrow(SearchAstError);
  });
});

describe('parseASTtoSQL — validation & the depth cap (spec §5.1)', () => {
  it('throws on an unknown field', () => {
    expect(() =>
      parseASTtoSQL(and({ field: 'nonsense', operator: 'EQUALS', value: 'x' })),
    ).toThrow(SearchAstError);
  });

  it('throws when an operator is unsupported for the field kind', () => {
    expect(() =>
      parseASTtoSQL(and({ field: 'name', operator: 'GREATER_THAN', value: 5 })),
    ).toThrow(/not supported/);
    expect(() =>
      parseASTtoSQL(and({ field: 'quantity', operator: 'CONTAINS', value: '5' })),
    ).toThrow(SearchAstError);
  });

  it('throws when a numeric field receives a non-numeric value', () => {
    expect(() =>
      parseASTtoSQL(and({ field: 'quantity', operator: 'EQUALS', value: 'lots' })),
    ).toThrow(/numeric/);
  });

  it(`allows exactly ${MAX_AST_GROUP_DEPTH} nested groups`, () => {
    // Build root(1) → group(2) → group(3) → group(4) with a leaf at the bottom.
    let node: ASTGroupNode = and({ field: 'quantity', operator: 'GREATER_THAN', value: 1 });
    for (let depth = MAX_AST_GROUP_DEPTH; depth > 1; depth -= 1) {
      node = and(node);
    }
    expect(() => parseASTtoSQL(node)).not.toThrow();
  });

  it(`throws past ${MAX_AST_GROUP_DEPTH} nested groups`, () => {
    let node: ASTGroupNode = and({ field: 'quantity', operator: 'GREATER_THAN', value: 1 });
    for (let depth = MAX_AST_GROUP_DEPTH + 1; depth > 1; depth -= 1) {
      node = and(node);
    }
    expect(() => parseASTtoSQL(node)).toThrow(/nested too deeply/);
  });
});

describe('parseASTtoSQL — executes correctly against a real SQLite engine', () => {
  let driver: MemoryDriver;

  async function makeItem(
    id: string,
    name: string,
    opts: { description?: string; manufacturer?: string; mpn?: string; quantity?: number } = {},
  ): Promise<void> {
    await driver.execute(
      `INSERT INTO items (id, name, description, manufacturer, mpn, quantity, location_id)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        name,
        opts.description ?? null,
        opts.manufacturer ?? null,
        opts.mpn ?? null,
        opts.quantity ?? 0,
        UNASSIGNED_LOCATION_ID,
      ],
    );
  }

  async function addCapability(
    itemId: string,
    key: string,
    valueNum: number | null,
    valueText: string | null = null,
  ): Promise<void> {
    await driver.execute(
      'INSERT INTO capabilities (id, item_id, key, value_num, value_text) VALUES (?, ?, ?, ?, ?);',
      [crypto.randomUUID(), itemId, key, valueNum, valueText],
    );
  }

  /** Run a parsed AST as a real query and return the matched ids, sorted. */
  async function run(ast: ASTGroupNode): Promise<string[]> {
    const [where, params] = parseASTtoSQL(ast);
    const rows = await driver.query<{ id: string }>(
      `SELECT id FROM items WHERE ${where} ORDER BY id;`,
      params,
    );
    return rows.map((r) => r.id);
  }

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await makeItem('reg', 'LM7805 Regulator', {
      description: '5V linear supply',
      manufacturer: 'TI',
      mpn: 'LM7805',
      quantity: 50,
    });
    await makeItem('mcu', 'ESP32 DevKit', {
      description: 'wifi microcontroller',
      manufacturer: 'Espressif',
      mpn: 'ESP32-WROOM',
      quantity: 3,
    });
    await addCapability('reg', 'voltage', 5);
    await addCapability('mcu', 'voltage', 3.3);
    await addCapability('mcu', 'package', null, 'SMD');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('matches a free-text CONTAINS via FTS5', async () => {
    expect(await run(and({ field: 'name', operator: 'CONTAINS', value: 'esp' }))).toEqual(['mcu']);
  });

  it('matches a numeric capability comparison', async () => {
    expect(
      await run(and({ field: 'capability:voltage', operator: 'GREATER_THAN', value: 4 })),
    ).toEqual(['reg']);
  });

  it('matches HAS_CAPABILITY existence', async () => {
    expect(
      await run(and({ field: 'capability:package', operator: 'HAS_CAPABILITY', value: true })),
    ).toEqual(['mcu']);
  });

  it('matches a text capability EQUALS case-insensitively', async () => {
    expect(
      await run(and({ field: 'capability:package', operator: 'EQUALS', value: 'smd' })),
    ).toEqual(['mcu']);
  });

  it('combines FTS + scalar + capability across AND/OR groups', async () => {
    // (quantity > 10) AND (manufacturer = TI OR capability:voltage < 4)
    const ids = await run(
      and(
        { field: 'quantity', operator: 'GREATER_THAN', value: 10 },
        or(
          { field: 'manufacturer', operator: 'EQUALS', value: 'TI' },
          { field: 'capability:voltage', operator: 'LESS_THAN', value: 4 },
        ),
      ),
    );
    expect(ids).toEqual(['reg']); // mcu fails quantity>10; reg passes via manufacturer=TI
  });

  it('match-all returns every item', async () => {
    expect(await run(and())).toEqual(['mcu', 'reg']);
  });
});
