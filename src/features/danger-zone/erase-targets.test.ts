import { describe, it, expect } from 'vitest';
import { STORAGE_KEYS } from '@/lib/storage-keys';
import { ERASE_SECTIONS, ERASE_TARGETS, eraseTargetById, type EraseTargetId } from './erase-targets';

/** Every id the contract pins — the catalog must expose exactly these. */
const ALL_IDS: EraseTargetId[] = [
  'items',
  'item-photos',
  'item-history',
  'checkouts',
  'maintenance',
  'supplier-parts',
  'suppliers',
  'custom-field-values',
  'tags',
  'categories',
  'field-dictionary',
  'locations',
  'location-photos',
  'projects',
  'purchase-orders',
  'contacts',
  'preferences',
  'dashboard-layout',
  'saved-searches',
  'dismissed-alerts',
  'cloud-signin',
  'sync-links',
  'enabled-features',
  'local-ui',
];

/** Join a target's built statements into one inspectable string. */
function sqlOf(id: EraseTargetId, tombstone: boolean, now = 1_000): string {
  const target = eraseTargetById(id);
  const statements = target?.buildStatements?.({ tombstone, now }) ?? [];
  return statements.map((s) => s.sql).join('\n');
}

describe('ERASE_TARGETS catalog', () => {
  it('exposes every contract id exactly once', () => {
    const ids = ERASE_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect([...ids].sort()).toEqual([...ALL_IDS].sort()); // complete
  });

  it('gives every target a non-empty label and tooltip', () => {
    for (const target of ERASE_TARGETS) {
      expect(target.label.length).toBeGreaterThan(0);
      expect(target.tooltip.length).toBeGreaterThan(0);
    }
  });

  it('only references known sections', () => {
    const sections = new Set(ERASE_SECTIONS.map((s) => s.id));
    for (const target of ERASE_TARGETS) expect(sections.has(target.section)).toBe(true);
  });

  it('gives db-scope targets a countSql and local-scope targets localKeys', () => {
    for (const target of ERASE_TARGETS) {
      if (target.scope === 'db') {
        expect(target.countSql, target.id).toBeDefined();
      } else {
        expect(target.localKeys?.length, target.id).toBeGreaterThan(0);
      }
    }
  });

  it('erases every localStorage key the shared registry files under a target (issue #378)', () => {
    for (const entry of STORAGE_KEYS) {
      if (entry.storage !== 'local' || entry.eraseGroup === null) continue;
      const target = eraseTargetById(entry.eraseGroup);
      expect(target, `${entry.key} names a group with no matching target`).toBeDefined();
      expect(target?.localKeys ?? [], `${entry.key} is not erased by ${entry.eraseGroup}`).toContain(
        entry.key,
      );
    }
  });

  it('never erases a localStorage key the registry deliberately excludes', () => {
    const excluded = STORAGE_KEYS.filter((e) => e.eraseGroup === null).map((e) => e.key);
    const erased = new Set(ERASE_TARGETS.flatMap((t) => t.localKeys ?? []));
    for (const key of excluded) expect(erased.has(key), key).toBe(false);
  });

  it('eraseTargetById resolves a known id and rejects an unknown one', () => {
    expect(eraseTargetById('items')?.id).toBe('items');
    expect(eraseTargetById('nope' as EraseTargetId)).toBeUndefined();
  });

  it('only lists real, cascade-covered children in `includes` (and never itself or `tags`)', () => {
    const ids = new Set(ERASE_TARGETS.map((t) => t.id));
    for (const target of ERASE_TARGETS) {
      for (const child of target.includes ?? []) {
        expect(ids.has(child), `${target.id} includes unknown ${child}`).toBe(true);
        expect(child, `${target.id} cannot include itself`).not.toBe(target.id);
      }
    }
    // "All items" subsumes its cascade children but NOT the Tags dictionary (only the links go).
    const items = eraseTargetById('items')!.includes ?? [];
    expect(items).toEqual([
      'item-photos',
      'item-history',
      'checkouts',
      'maintenance',
      'supplier-parts',
      'custom-field-values',
    ]);
    expect(items).not.toContain('tags');
    // Categories cascade to field values; contacts cascade to their checkouts.
    expect(eraseTargetById('categories')!.includes).toEqual(['custom-field-values']);
    expect(eraseTargetById('contacts')!.includes).toEqual(['checkouts']);
  });
});

describe('buildStatements — tombstone toggling', () => {
  it('items: no tombstones when off; tombstones (incl. edge form) when on; always unlinks + watermark + final delete', () => {
    const off = sqlOf('items', false);
    expect(off).not.toContain('INSERT OR REPLACE INTO tombstones');
    expect(off).toContain('UPDATE project_bom_lines SET item_id = NULL');
    expect(off).toContain('UPDATE purchase_order_lines SET item_id = NULL');
    expect(off).toContain('history_pruned_before = MAX(history_pruned_before, ?)');
    expect(off.trimEnd().endsWith('DELETE FROM items;')).toBe(true);

    const on = sqlOf('items', true);
    expect(on).toContain('INSERT OR REPLACE INTO tombstones');
    // item_tags edge tombstone uses the composite `item_id || '|' || tag_id` form.
    expect(on).toContain("SELECT 'item_tags', item_id || '|' || tag_id FROM item_tags");
    // Children are tombstoned before the parent items row.
    expect(on.indexOf("'item_images'")).toBeLessThan(on.indexOf("'items', id FROM items"));
    // The DELETE FROM items is still last.
    expect(on.trimEnd().endsWith('DELETE FROM items;')).toBe(true);
  });

  it('items: binds now to the history watermark UPDATE', () => {
    const statements = eraseTargetById('items')!.buildStatements!({ tombstone: false, now: 42 });
    const watermark = statements.find((s) => s.sql.includes('history_pruned_before'));
    expect(watermark?.params).toEqual([42]);
  });

  it('categories: always nulls items.category_id; tombstones fields + categories only when on', () => {
    const off = sqlOf('categories', false);
    expect(off).toContain('UPDATE items SET category_id = NULL');
    expect(off).not.toContain('INSERT OR REPLACE INTO tombstones');
    expect(off.trimEnd().endsWith('DELETE FROM categories;')).toBe(true);

    const on = sqlOf('categories', true);
    expect(on).toContain("'item_field_values'");
    expect(on).toContain("'category_fields'");
    expect(on).toContain("'categories'");
  });

  it('contacts: tombstones the cascading checkouts as well as contacts when on', () => {
    const on = sqlOf('contacts', true);
    expect(on).toContain("'checkouts'");
    expect(on).toContain("'contacts'");
    expect(on.trimEnd().endsWith('DELETE FROM contacts;')).toBe(true);
    expect(sqlOf('contacts', false)).not.toContain('tombstones');
  });

  it('locations: uses an identical emptiness predicate for tombstone and delete; never touches system rows', () => {
    const on = sqlOf('locations', true);
    expect(on).toContain('is_system = 0');
    // The DELETE is sub-query gated, not a bare table delete.
    expect(on).toContain('DELETE FROM locations WHERE id IN (SELECT');
    // countSql shares the same predicate.
    expect(eraseTargetById('locations')!.countSql).toContain('is_system = 0');
  });

  it('item-history: never tombstones, always advances the watermark to now', () => {
    const statements = eraseTargetById('item-history')!.buildStatements!({
      tombstone: true,
      now: 99,
    });
    const sql = statements.map((s) => s.sql).join('\n');
    expect(sql).not.toContain('tombstones');
    expect(sql).toContain('DELETE FROM item_history;');
    const watermark = statements.find((s) => s.sql.includes('history_pruned_before'));
    expect(watermark?.params).toEqual([99]);
  });

  it('suppliers: keeps the purchase orders, unlinking them and the PO lines', () => {
    const off = sqlOf('suppliers', false);
    expect(off).not.toContain('INSERT OR REPLACE INTO tombstones');
    // purchase_orders.supplier_id is ON DELETE SET NULL, so the orders outlive the supplier
    // delete — they record what was spent. Both links are unlinked as explicit edits (rather
    // than left to the FK) so they sync as intentional writes.
    expect(off).not.toContain('DELETE FROM purchase_orders;');
    expect(off).not.toContain('DELETE FROM purchase_order_lines;');
    expect(off).toContain('UPDATE purchase_orders SET supplier_id = NULL');
    expect(off).toContain('UPDATE purchase_order_lines SET supplier_part_id = NULL');
    // Both unlinks land before the delete that would otherwise fire the FK silently.
    expect(off.indexOf('UPDATE purchase_orders SET supplier_id = NULL')).toBeLessThan(
      off.indexOf('DELETE FROM suppliers;'),
    );
    // Supplier parts cascade from the suppliers delete, which is the last statement.
    expect(off.trimEnd().endsWith('DELETE FROM suppliers;')).toBe(true);

    const on = sqlOf('suppliers', true);
    // The cascading child is tombstoned before the suppliers row it hangs off; the orders are
    // not tombstoned at all, because they are not deleted.
    expect(on).toContain("'supplier_parts'");
    expect(on.indexOf("'supplier_parts'")).toBeLessThan(on.indexOf("'suppliers'"));
    expect(on).not.toContain("'purchase_orders'");
    expect(on).not.toContain("'purchase_order_lines'");
  });

  it('sync-links: clears tombstones + zeroes sync cursor, never tombstones, never touches history watermark', () => {
    const sql = sqlOf('sync-links', true);
    expect(sql).toContain('DELETE FROM tombstones;');
    expect(sql).toContain('last_sync_timestamp = 0');
    expect(sql).toContain('clock_offset = 0');
    expect(sql).not.toContain('INSERT OR REPLACE INTO tombstones');
    expect(sql).not.toContain('history_pruned_before');
    expect(eraseTargetById('sync-links')!.clearsIdb).toEqual(['gubbins-fs']);
  });
});
