import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';
import {
  ATTACHMENT_KINDS,
  CONDITIONS,
  COSTING_MODES,
  DEAD_STOCK_MODES,
  FIELD_TYPES,
  FIELD_VALUE_MODES,
  MAINTENANCE_BASES,
  PRICE_HISTORY_SOURCES,
  PROCUREMENT_STATUSES,
  PROJECT_STATUSES,
  PURCHASE_ORDER_STATUSES,
  REGION_SHAPES,
  RESERVATION_STATUSES,
  TRACKING_MODES,
  USER_KINDS,
  WEBHOOK_METHODS,
} from '@/db/repositories/constants';
import { RELATION_KINDS } from '@/features/inventory/item-relations';
import { TARE_PRESET_KINDS } from '@/features/inventory/tare-presets';
import { TEST_RECORD_KINDS, TEST_RESULTS } from '@/features/inventory/test-records';
import { WISHLIST_PRIORITIES } from '@/features/purchasing/wishlist';

/**
 * Drift guard (issue #605). Every enum column in the schema is one of two deliberate shapes,
 * and this asserts each one really is the shape it claims to be — against the **built**
 * schema read back out of `sqlite_master`, not against the DDL source text, so a hand-edited
 * `CHECK` is caught exactly like a widened constant.
 *
 * `v1-initial.ts` builds each constrained column's `CHECK` list by interpolating the shared
 * constant, so the two cannot drift *as written*. That is not the same as proving it: the
 * three lists this issue fixed were hand-written for exactly as long as nothing checked, and
 * a widened union type-checked cleanly right up to the first `UPDATE` that persisted the new
 * value and aborted the transaction on the constraint.
 *
 * The unconstrained columns are the other half. Each has a real vocabulary in code and no
 * `CHECK` **on purpose** — a constraint that rejects a row on hydration would let one value
 * from a newer peer abort a whole sync apply, so they soften on read at the mapper instead
 * (the same reasoning the `webhooks` JSON columns carry). Their DDL comments used to restate
 * the vocabulary, and `item_relations.kind`'s had already gone stale; naming the constant and
 * asserting the absence here is what keeps the choice deliberate rather than forgotten.
 */

/** A table's stored `CREATE TABLE` text, as SQLite kept it (ALTER-added columns included). */
interface TableSql {
  readonly name: string;
  readonly sql: string;
}

/** A row of `PRAGMA table_info(<table>)`. */
interface ColumnRow {
  readonly name: string;
}

/**
 * Matches an enum-shaped `CHECK` — a column tested against a list of **string** literals,
 * optionally behind the `<col> IS NULL OR` guard the nullable ones carry. Numeric lists
 * (`is_system IN (0, 1)`) are not enum vocabularies and deliberately do not match.
 */
const ENUM_CHECK =
  /CHECK\s*\(\s*(?:"?\w+"?\s+IS\s+NULL\s+OR\s+)?"?(\w+)"?\s+IN\s*\(\s*('(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*)\s*\)\s*\)/gi;

/** The vocabulary each constrained column's `CHECK` must carry, keyed `<table>.<column>`. */
const CONSTRAINED: Readonly<Record<string, readonly string[]>> = {
  'categories.default_condition': CONDITIONS,
  'categories.default_maintenance_basis': MAINTENANCE_BASES,
  'categories.default_tracking_mode': TRACKING_MODES,
  'field_defs.field_type': FIELD_TYPES,
  'item_attachments.kind': ATTACHMENT_KINDS,
  'item_field_values.mode': FIELD_VALUE_MODES,
  'items.condition': CONDITIONS,
  'items.dead_stock_mode': DEAD_STOCK_MODES,
  'items.tracking_mode': TRACKING_MODES,
  'location_regions.shape': REGION_SHAPES,
  'locations.dead_stock_mode': DEAD_STOCK_MODES,
  'maintenance_schedules.basis': MAINTENANCE_BASES,
  'project_bom_lines.procurement_status': PROCUREMENT_STATUSES,
  'project_bom_lines.reservation_status': RESERVATION_STATUSES,
  'projects.costing_mode': COSTING_MODES,
  'projects.status': PROJECT_STATUSES,
  'purchase_orders.status': PURCHASE_ORDER_STATUSES,
  'supplier_part_price_history.source': PRICE_HISTORY_SOURCES,
  'users.kind': USER_KINDS,
  'webhooks.method': WEBHOOK_METHODS,
};

/**
 * The columns that hold a vocabulary but carry **no** `CHECK`, each with the constant the
 * DDL comment points at. Adding a constraint to one of these fails this suite, which is the
 * point: it is a decision about what a newer peer's value should do to a sync apply, not a
 * consistency tidy-up.
 */
const UNCONSTRAINED: Readonly<Record<string, readonly string[]>> = {
  'item_relations.kind': RELATION_KINDS,
  'tare_presets.kind': TARE_PRESET_KINDS,
  'test_records.kind': TEST_RECORD_KINDS,
  'test_records.result': TEST_RESULTS,
  'wishlist.priority': WISHLIST_PRIORITIES,
};

describe('enum CHECK lists match their constants (#605)', () => {
  let driver: MemoryDriver;
  /** Every enum-shaped CHECK the built schema declares, `<table>.<column>` to its value list. */
  let declared: Map<string, string[]>;

  beforeAll(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    const tables = await driver.query<TableSql>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL;`,
    );
    declared = new Map();
    for (const table of tables) {
      for (const match of table.sql.matchAll(ENUM_CHECK)) {
        const values = match[2]
          .split(',')
          .map((literal) => literal.trim().slice(1, -1).replaceAll("''", "'"));
        declared.set(`${table.name}.${match[1]}`, values);
      }
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('finds the constraints it is meant to be checking (the enumeration works)', () => {
    // Guards against the whole suite passing because the pattern matched nothing.
    expect(declared.size).toBe(Object.keys(CONSTRAINED).length);
    expect(declared.get('users.kind')).toEqual(['system', 'admin', 'normal']);
    // A nullable column, so its CHECK sits behind the `IS NULL OR` guard the pattern must skip.
    expect(declared.get('items.condition')).toEqual([...CONDITIONS]);
  });

  it('gives every constrained column exactly its constant, in order', () => {
    const problems: string[] = [];
    for (const [column, want] of Object.entries(CONSTRAINED)) {
      const got = declared.get(column);
      if (!got) {
        problems.push(`${column}: no enum CHECK in the built schema`);
        continue;
      }
      if (got.join('|') !== want.join('|')) {
        problems.push(`${column}: schema has [${got.join(', ')}] but the constant is [${want.join(', ')}]`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('registers every enum CHECK the schema declares', () => {
    // A new hand-written CHECK list — the shape this issue removed — lands here rather than
    // sitting unchecked until a widened union aborts a write.
    const unregistered = [...declared.keys()].filter((column) => !(column in CONSTRAINED));
    expect(unregistered).toEqual([]);
  });

  it('leaves the deliberately unconstrained columns unconstrained', async () => {
    const problems: string[] = [];
    for (const [column, vocabulary] of Object.entries(UNCONSTRAINED)) {
      const [table, name] = column.split('.');
      const columns = await driver.query<ColumnRow>(`PRAGMA table_info(${table});`);
      if (!columns.some((c) => c.name === name)) {
        problems.push(`${column}: no such column — the registry names one the schema dropped`);
        continue;
      }
      if (declared.has(column)) {
        problems.push(`${column}: now carries a CHECK; decide what it does to a sync apply first`);
      }
      // The DDL comment points at the constant by name instead of restating its values, so an
      // emptied or renamed constant would leave the comment pointing at nothing.
      if (vocabulary.length === 0) problems.push(`${column}: its vocabulary constant is empty`);
    }
    expect(problems).toEqual([]);
  });
});
