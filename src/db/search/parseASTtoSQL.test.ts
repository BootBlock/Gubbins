import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { MAX_AST_GROUP_DEPTH, type ASTGroupNode, type FilterCondition } from './ast';
import { collectCapabilityKeys, parseASTtoSQL, SearchAstError } from './parseASTtoSQL';

/** Wrap conditions in a root AND group for brevity. */
function and(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'AND', conditions };
}
function or(...conditions: Array<ASTGroupNode | FilterCondition>): ASTGroupNode {
  return { type: 'GROUP', logicalOperator: 'OR', conditions };
}

describe('collectCapabilityKeys — best-match ranking inputs (spec §4, §5.1)', () => {
  it('returns an empty list when no condition filters on a capability', () => {
    expect(collectCapabilityKeys(and({ field: 'name', operator: 'CONTAINS', value: 'esp' }))).toEqual([]);
    expect(collectCapabilityKeys(and())).toEqual([]);
  });

  it('extracts capability keys, lower-cased and de-duplicated, across nested groups', () => {
    const ast = and(
      { field: 'capability:Voltage', operator: 'GREATER_THAN', value: 3 },
      or(
        { field: 'capability:voltage', operator: 'LESS_THAN', value: 12 },
        { field: 'capability:Package', operator: 'EQUALS', value: 'TO-220' },
      ),
      { field: 'quantity', operator: 'GREATER_THAN', value: 1 },
    );
    expect(collectCapabilityKeys(ast).sort()).toEqual(['package', 'voltage']);
  });

  it('ignores a capability prefix with a blank key', () => {
    expect(
      collectCapabilityKeys(and({ field: 'capability:', operator: 'HAS_CAPABILITY', value: '' })),
    ).toEqual([]);
  });
});

describe('parseASTtoSQL — structure & parameterisation (spec §5.1)', () => {
  it('returns match-all for an empty tree', () => {
    expect(parseASTtoSQL(and())).toEqual(['1', []]);
  });

  it('translates a case-insensitive text EQUALS with a bound parameter', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'manufacturer', operator: 'EQUALS', value: 'TI' }));
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

  it('translates the boolean favourite flag (issue #23) to an is_favourite = 0/1 match', () => {
    expect(parseASTtoSQL(and({ field: 'favourite', operator: 'EQUALS', value: true }))).toEqual([
      '(items.is_favourite = ?)',
      [1],
    ]);
    expect(parseASTtoSQL(and({ field: 'favourite', operator: 'EQUALS', value: false }))).toEqual([
      '(items.is_favourite = ?)',
      [0],
    ]);
    // The text-query path may hand it a word; it coerces the same way.
    expect(parseASTtoSQL(and({ field: 'favourite', operator: 'EQUALS', value: 'yes' }))).toEqual([
      '(items.is_favourite = ?)',
      [1],
    ]);
  });

  it('rejects an ordering comparison on the boolean favourite field', () => {
    expect(() => parseASTtoSQL(and({ field: 'favourite', operator: 'GREATER_THAN', value: 1 }))).toThrow(
      SearchAstError,
    );
  });

  it('routes free-text CONTAINS through the FTS5 index, scoped to the column', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'description', operator: 'CONTAINS', value: 'voltage reg' }),
    );
    expect(sql).toBe('(items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?))');
    expect(params).toEqual(['description : ("voltage"* "reg"*)']);
  });

  it('scopes a CONTAINS on notes to the FTS index rather than the always-false 0 (issue #120)', () => {
    // `notes` is indexed by items_fts, so a scoped notes CONTAINS must compile to a real
    // MATCH — not degrade to the literal `0` (valid SQL that matches nothing).
    const [sql, params] = parseASTtoSQL(and({ field: 'notes', operator: 'CONTAINS', value: 'spare' }));
    expect(sql).toBe('(items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?))');
    expect(sql).not.toBe('(0)');
    expect(params).toEqual(['notes : ("spare"*)']);
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
    const [sql, params] = parseASTtoSQL(or({ field: 'quantity', operator: 'GREATER_THAN', value: 1 }, and()));
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

describe('parseASTtoSQL — custom fields (spec §4 Categories & Schema Evolution, Phase 71)', () => {
  it('translates a presence HAS_CAPABILITY to an EXISTS over the effective-value join', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'field:Datasheet', operator: 'HAS_CAPABILITY', value: '' }),
    );
    expect(sql).toBe(
      '(EXISTS (SELECT 1 FROM item_field_effective_values ifv JOIN field_defs fd ON fd.id = ifv.def_id ' +
        "WHERE ifv.item_id = items.id AND fd.name = ? COLLATE NOCASE AND fd.field_type <> 'IMAGE' " +
        'AND ifv.value IS NOT NULL))',
    );
    expect(params).toEqual(['Datasheet']);
  });

  it('never matches an IMAGE field — its base64 value is not searchable text (issue #453)', () => {
    const [sql] = parseASTtoSQL(and({ field: 'field:Cover art', operator: 'CONTAINS', value: 'x' }));
    expect(sql).toContain("fd.field_type <> 'IMAGE'");
  });

  it('translates a text CONTAINS to a LIKE with the field name bound first', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'field:Notes', operator: 'CONTAINS', value: 'rev2' }));
    expect(sql).toContain("AND ifv.value LIKE ? ESCAPE '\\'");
    expect(params).toEqual(['Notes', '%rev2%']);
  });

  it('escapes LIKE wildcards in a custom-field CONTAINS value', () => {
    const [, params] = parseASTtoSQL(and({ field: 'field:Notes', operator: 'CONTAINS', value: '50%_x' }));
    expect(params).toEqual(['Notes', '%50\\%\\_x%']);
  });

  it('translates a text EQUALS case-insensitively against the stored value', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'field:Colour', operator: 'EQUALS', value: 'Red' }));
    expect(sql).toContain('AND ifv.value = ? COLLATE NOCASE');
    expect(params).toEqual(['Colour', 'Red']);
  });

  it('translates a numeric comparison casting the TEXT value to REAL', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'field:Rating', operator: 'GREATER_THAN', value: 3.3 }));
    expect(sql).toContain('AND CAST(ifv.value AS REAL) > ?');
    expect(params).toEqual(['Rating', 3.3]);
  });

  it('translates a numeric EQUALS casting the TEXT value to REAL', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'field:Rating', operator: 'EQUALS', value: 5 }));
    expect(sql).toContain('AND CAST(ifv.value AS REAL) = ?');
    expect(params).toEqual(['Rating', 5]);
  });

  it('rejects a custom-field reference with no name', () => {
    expect(() => parseASTtoSQL(and({ field: 'field:', operator: 'HAS_CAPABILITY', value: '' }))).toThrow(
      SearchAstError,
    );
  });

  it('never concatenates the field name or value into the SQL text', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'field:Notes', operator: 'EQUALS', value: "x'); DROP TABLE items;--" }),
    );
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toEqual(['Notes', "x'); DROP TABLE items;--"]);
  });
});

describe('parseASTtoSQL — tags (issue #138)', () => {
  it('translates a tag CONTAINS to an EXISTS over the item↔tag join', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'tag', operator: 'CONTAINS', value: 'expo' }));
    expect(sql).toBe(
      '(EXISTS (SELECT 1 FROM item_tags it JOIN tags tg ON tg.id = it.tag_id ' +
        "WHERE it.item_id = items.id AND tg.name LIKE ? ESCAPE '\\'))",
    );
    expect(params).toEqual(['%expo%']);
  });

  it('translates a tag EQUALS to a case-insensitive whole-name match', () => {
    const [sql, params] = parseASTtoSQL(and({ field: 'tag', operator: 'EQUALS', value: 'Fragile' }));
    expect(sql).toContain('AND tg.name = ? COLLATE NOCASE');
    expect(params).toEqual(['Fragile']);
  });

  it('escapes LIKE wildcards in a tag CONTAINS value', () => {
    const [, params] = parseASTtoSQL(and({ field: 'tag', operator: 'CONTAINS', value: '50%_x' }));
    expect(params).toEqual(['%50\\%\\_x%']);
  });

  it('accepts the field name case-insensitively', () => {
    const [sql] = parseASTtoSQL(and({ field: 'Tag', operator: 'CONTAINS', value: 'expo' }));
    expect(sql).toContain('FROM item_tags it');
  });

  it('rejects an ordering comparison on a tag name', () => {
    expect(() => parseASTtoSQL(and({ field: 'tag', operator: 'GREATER_THAN', value: 3 }))).toThrow(
      /not supported/,
    );
    expect(() => parseASTtoSQL(and({ field: 'tag', operator: 'HAS_CAPABILITY', value: '' }))).toThrow(
      SearchAstError,
    );
  });

  it('never concatenates the tag name into the SQL text', () => {
    const [sql, params] = parseASTtoSQL(
      and({ field: 'tag', operator: 'EQUALS', value: "x'); DROP TABLE items;--" }),
    );
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toEqual(["x'); DROP TABLE items;--"]);
  });
});

describe('parseASTtoSQL — validation & the depth cap (spec §5.1)', () => {
  it('throws on an unknown field', () => {
    expect(() => parseASTtoSQL(and({ field: 'nonsense', operator: 'EQUALS', value: 'x' }))).toThrow(
      SearchAstError,
    );
  });

  it('throws when an operator is unsupported for the field kind', () => {
    expect(() => parseASTtoSQL(and({ field: 'name', operator: 'GREATER_THAN', value: 5 }))).toThrow(
      /not supported/,
    );
    expect(() => parseASTtoSQL(and({ field: 'quantity', operator: 'CONTAINS', value: '5' }))).toThrow(
      SearchAstError,
    );
  });

  it('throws when a numeric field receives a non-numeric value', () => {
    expect(() => parseASTtoSQL(and({ field: 'quantity', operator: 'EQUALS', value: 'lots' }))).toThrow(
      /numeric/,
    );
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
    opts: {
      description?: string;
      manufacturer?: string;
      mpn?: string;
      quantity?: number;
      notes?: string;
    } = {},
  ): Promise<void> {
    await driver.execute(
      `INSERT INTO items (id, name, description, manufacturer, mpn, quantity, notes, location_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        name,
        opts.description ?? null,
        opts.manufacturer ?? null,
        opts.mpn ?? null,
        opts.quantity ?? 0,
        opts.notes ?? null,
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

  /**
   * Define a dictionary field and assign it to a category, returning the **definition**
   * id (issue #97 — values key on the definition, not on a category's use of it).
   */
  async function addCategoryField(categoryId: string, name: string, fieldType: string): Promise<string> {
    const defId = crypto.randomUUID();
    await driver.execute(`INSERT INTO field_defs (id, name, field_type) VALUES (?, ?, ?);`, [
      defId,
      name,
      fieldType,
    ]);
    await driver.execute(`INSERT INTO category_fields (id, category_id, def_id) VALUES (?, ?, ?);`, [
      crypto.randomUUID(),
      categoryId,
      defId,
    ]);
    return defId;
  }

  /** Set an item's own value for a defined custom field (TEXT EAV). */
  async function setFieldValue(itemId: string, defId: string, value: string): Promise<void> {
    await driver.execute(
      `INSERT INTO item_field_values (id, item_id, def_id, value, mode) VALUES (?, ?, ?, ?, 'literal');`,
      [crypto.randomUUID(), itemId, defId, value],
    );
  }

  /** Mark a location as offering an inheritable value for a definition (issue #97). */
  async function setLocationFieldValue(locationId: string, defId: string, value: string): Promise<void> {
    await driver.execute(
      `INSERT INTO location_field_values (id, location_id, def_id, value, is_inheritable)
       VALUES (?, ?, ?, ?, 1);`,
      [crypto.randomUUID(), locationId, defId, value],
    );
  }

  /** Record an item's intent to inherit a definition from its location (issue #97). */
  async function setFieldInherited(itemId: string, defId: string): Promise<void> {
    await driver.execute(
      `INSERT INTO item_field_values (id, item_id, def_id, value, mode) VALUES (?, ?, ?, NULL, 'inherit');`,
      [crypto.randomUUID(), itemId, defId],
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
      notes: 'Keep a spare on the bench',
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

  it('matches a column-scoped CONTAINS on notes via FTS5 (issue #120)', async () => {
    // Only the MCU carries a note; a scoped notes search must find it (and nothing else).
    expect(await run(and({ field: 'notes', operator: 'CONTAINS', value: 'spare' }))).toEqual(['mcu']);
  });

  it('filters by the boolean favourite flag against the real engine (issue #23)', async () => {
    // Star the regulator; the MCU stays a non-favourite.
    await driver.execute("UPDATE items SET is_favourite = 1 WHERE id = 'reg';");
    expect(await run(and({ field: 'favourite', operator: 'EQUALS', value: true }))).toEqual(['reg']);
    expect(await run(and({ field: 'favourite', operator: 'EQUALS', value: false }))).toEqual(['mcu']);
  });

  it('matches a numeric capability comparison', async () => {
    expect(await run(and({ field: 'capability:voltage', operator: 'GREATER_THAN', value: 4 }))).toEqual([
      'reg',
    ]);
  });

  it('matches HAS_CAPABILITY existence', async () => {
    expect(await run(and({ field: 'capability:package', operator: 'HAS_CAPABILITY', value: true }))).toEqual([
      'mcu',
    ]);
  });

  it('matches a text capability EQUALS case-insensitively', async () => {
    expect(await run(and({ field: 'capability:package', operator: 'EQUALS', value: 'smd' }))).toEqual([
      'mcu',
    ]);
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

  describe('custom-field predicates join item_field_values ⋈ category_fields (Phase 71)', () => {
    beforeEach(async () => {
      // A category with two custom fields; the two seeded items carry differing values.
      await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat-1', 'Chips']);
      const ratingId = await addCategoryField('cat-1', 'Rating', 'NUMBER');
      const notesId = await addCategoryField('cat-1', 'Notes', 'TEXT');
      await setFieldValue('reg', ratingId, '5');
      await setFieldValue('reg', notesId, 'Datasheet rev2');
      await setFieldValue('mcu', ratingId, '3.3');
      // mcu deliberately has no Notes value.
    });

    it('matches a custom-field text CONTAINS', async () => {
      expect(await run(and({ field: 'field:Notes', operator: 'CONTAINS', value: 'rev2' }))).toEqual(['reg']);
    });

    it('matches a custom-field text EQUALS case-insensitively', async () => {
      expect(await run(and({ field: 'field:Notes', operator: 'EQUALS', value: 'datasheet rev2' }))).toEqual([
        'reg',
      ]);
    });

    it('matches a numeric custom-field comparison casting TEXT to REAL', async () => {
      // 5 > 4 (reg) but 3.3 < 4 (mcu) — a lexical compare would wrongly include "3.3".
      expect(await run(and({ field: 'field:Rating', operator: 'GREATER_THAN', value: 4 }))).toEqual(['reg']);
    });

    it('matches custom-field presence (HAS_CAPABILITY) only where a value exists', async () => {
      expect(await run(and({ field: 'field:Notes', operator: 'HAS_CAPABILITY', value: '' }))).toEqual([
        'reg',
      ]);
    });

    it('an unknown custom-field name matches nothing (no error)', async () => {
      expect(await run(and({ field: 'field:DoesNotExist', operator: 'CONTAINS', value: 'x' }))).toEqual([]);
    });

    it('resolves the field name case-insensitively', async () => {
      expect(await run(and({ field: 'field:rating', operator: 'EQUALS', value: 5 }))).toEqual(['reg']);
    });
  });

  /**
   * Issue #97 — a value an item *inherits* from its location must be as findable as one it
   * stores. Searching through the raw value rows would miss these entirely (they hold NULL
   * and defer to the location), which is the whole reason predicates read the
   * `item_field_effective_values` view instead.
   */
  describe('custom-field predicates see location-inherited values (issue #97)', () => {
    let makerId: string;

    beforeEach(async () => {
      await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', ['cat-1', 'Chips']);
      makerId = await addCategoryField('cat-1', 'Maker', 'TEXT');

      // A cabinet inside Unassigned offers Maker = Ryobi to everything beneath it.
      await driver.execute('INSERT INTO locations (id, name, parent_id) VALUES (?, ?, ?);', [
        'cabinet',
        'Cabinet A',
        UNASSIGNED_LOCATION_ID,
      ]);
      await setLocationFieldValue('cabinet', makerId, 'Ryobi');
      await driver.execute("UPDATE items SET location_id = 'cabinet' WHERE id = 'mcu';");
    });

    it('matches an item that inherits the value rather than storing it', async () => {
      await setFieldInherited('mcu', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'EQUALS', value: 'Ryobi' }))).toEqual(['mcu']);
    });

    it('counts an inherited value as present for HAS_CAPABILITY', async () => {
      await setFieldInherited('mcu', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'HAS_CAPABILITY', value: '' }))).toEqual([
        'mcu',
      ]);
    });

    it('does not match an item whose location offers no value for the field', async () => {
      // `reg` is still in Unassigned, which offers nothing, so inheriting resolves to NULL.
      await setFieldInherited('reg', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'HAS_CAPABILITY', value: '' }))).toEqual([]);
    });

    it("prefers an item's own stored value over the one its location offers", async () => {
      await setFieldValue('mcu', makerId, 'Makita');
      expect(await run(and({ field: 'field:Maker', operator: 'EQUALS', value: 'Makita' }))).toEqual(['mcu']);
      expect(await run(and({ field: 'field:Maker', operator: 'EQUALS', value: 'Ryobi' }))).toEqual([]);
    });

    it('follows the value down through a nested location', async () => {
      // A drawer inside the cabinet inherits the cabinet's offer transitively.
      await driver.execute('INSERT INTO locations (id, name, parent_id) VALUES (?, ?, ?);', [
        'drawer',
        'Drawer 3',
        'cabinet',
      ]);
      await driver.execute("UPDATE items SET location_id = 'drawer' WHERE id = 'mcu';");
      await setFieldInherited('mcu', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'EQUALS', value: 'Ryobi' }))).toEqual(['mcu']);
    });

    it('takes the nearest location when both a parent and a child offer a value', async () => {
      await driver.execute('INSERT INTO locations (id, name, parent_id) VALUES (?, ?, ?);', [
        'drawer',
        'Drawer 3',
        'cabinet',
      ]);
      await setLocationFieldValue('drawer', makerId, 'Makita');
      await driver.execute("UPDATE items SET location_id = 'drawer' WHERE id = 'mcu';");
      await setFieldInherited('mcu', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'EQUALS', value: 'Makita' }))).toEqual(['mcu']);
    });

    it('ignores a location value that is not marked inheritable', async () => {
      await driver.execute(
        "UPDATE location_field_values SET is_inheritable = 0 WHERE location_id = 'cabinet';",
      );
      await setFieldInherited('mcu', makerId);
      expect(await run(and({ field: 'field:Maker', operator: 'HAS_CAPABILITY', value: '' }))).toEqual([]);
    });
  });

  describe('tag predicates join item_tags ⋈ tags (issue #138)', () => {
    /** Define a tag in the shared dictionary and attach it to an item. */
    async function addTag(itemId: string, name: string): Promise<void> {
      const tagId = crypto.randomUUID();
      await driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', [tagId, name]);
      await driver.execute('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?);', [itemId, tagId]);
    }

    beforeEach(async () => {
      await addTag('reg', 'Fragile');
      await addTag('reg', 'expo-2026');
      await addTag('mcu', 'wireless');
    });

    it('matches a whole tag name case-insensitively', async () => {
      expect(await run(and({ field: 'tag', operator: 'EQUALS', value: 'fragile' }))).toEqual(['reg']);
    });

    it('matches a partial tag name with CONTAINS', async () => {
      expect(await run(and({ field: 'tag', operator: 'CONTAINS', value: 'expo' }))).toEqual(['reg']);
    });

    it("matches when any of an item's several tags satisfies the predicate", async () => {
      // `reg` carries two tags; either one must find it.
      expect(await run(and({ field: 'tag', operator: 'EQUALS', value: 'expo-2026' }))).toEqual(['reg']);
      expect(await run(and({ field: 'tag', operator: 'EQUALS', value: 'Fragile' }))).toEqual(['reg']);
    });

    it('matches nothing for a tag no item carries', async () => {
      expect(await run(and({ field: 'tag', operator: 'EQUALS', value: 'nonexistent' }))).toEqual([]);
    });

    it('returns each matching item once however many of its tags match', async () => {
      // Both of `reg`'s tags contain an "e", but EXISTS must not duplicate the row.
      expect(await run(and({ field: 'tag', operator: 'CONTAINS', value: 'e' }))).toEqual(['mcu', 'reg']);
    });

    it('ignores a tag that sits on a location rather than the item', async () => {
      const tagId = crypto.randomUUID();
      await driver.execute('INSERT INTO tags (id, name) VALUES (?, ?);', [tagId, 'climate-controlled']);
      await driver.execute('INSERT INTO location_tags (location_id, tag_id) VALUES (?, ?);', [
        UNASSIGNED_LOCATION_ID,
        tagId,
      ]);
      expect(await run(and({ field: 'tag', operator: 'EQUALS', value: 'climate-controlled' }))).toEqual([]);
    });

    it('combines a tag predicate with the other field kinds across AND/OR', async () => {
      // tag:wireless AND quantity < 10 → only the MCU (qty 3); the regulator holds 50.
      const ids = await run(
        and(
          { field: 'tag', operator: 'CONTAINS', value: 'wireless' },
          { field: 'quantity', operator: 'LESS_THAN', value: 10 },
        ),
      );
      expect(ids).toEqual(['mcu']);
    });
  });
});
