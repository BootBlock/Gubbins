import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import {
  ITEM_REFERENCE_SPECS,
  ItemRepository,
  TombstoneRepository,
  UNASSIGNED_LOCATION_ID,
  totalItemReferences,
  type ItemReferenceKind,
} from './index';

/**
 * Deduplication at the repository seam (issue #99) — the scan, the reference tally, and the merge.
 *
 * The centrepiece is the **drift test**: `ITEM_REFERENCE_SPECS` is the one list saying what counts
 * as a reference to an item, and the merge handles each kind by hand. The seeder below is typed
 * `Record<ItemReferenceKind, …>`, so adding a kind to that list fails to compile until this test
 * knows how to create one — and the test then fails unless the merge actually moves it. A kind
 * that is counted but not re-pointed cannot pass silently.
 */
describe('Item deduplication (issue #99)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let tombstones: TombstoneRepository;
  let keep: string;
  let gone: string;

  /**
   * One row of each reference kind, pointing at `itemId`. Raw SQL rather than the repositories:
   * the point is to exercise every column in `ITEM_REFERENCE_SPECS`, including the ones no
   * repository method would let a caller reach in this combination.
   */
  const seeders: Record<ItemReferenceKind, (itemId: string, tag: string) => Promise<void>> = {
    checkouts: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO checkouts (id, item_id, location_id, quantity, checked_out_at)
         VALUES (?, ?, ?, 1, 1000);`,
        [`co-${tag}`, itemId, UNASSIGNED_LOCATION_ID],
      );
    },
    bookings: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO asset_bookings (id, item_id, start_date, end_date) VALUES (?, ?, 1000, 2000);`,
        [`bk-${tag}`, itemId],
      );
    },
    maintenance: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days)
         VALUES (?, ?, 'Service', 'TIME', 30);`,
        [`ms-${tag}`, itemId],
      );
    },
    projectBomLines: async (itemId, tag) => {
      await driver.execute(`INSERT INTO project_bom_lines (id, project_id, item_id) VALUES (?, 'proj', ?);`, [
        `bom-${tag}`,
        itemId,
      ]);
    },
    purchaseOrderLines: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO purchase_order_lines (id, po_id, item_id, ordered_qty) VALUES (?, 'po', ?, 1);`,
        [`pol-${tag}`, itemId],
      );
    },
    testRecords: async (itemId, tag) => {
      await driver.execute(`INSERT INTO test_records (id, item_id, name) VALUES (?, ?, 'Calibration');`, [
        `tr-${tag}`,
        itemId,
      ]);
    },
    revaluations: async (itemId, tag) => {
      await driver.execute(`INSERT INTO revaluations (id, item_id, value) VALUES (?, ?, 500);`, [
        `rv-${tag}`,
        itemId,
      ]);
    },
    supplierParts: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO supplier_parts (id, item_id, supplier_id, order_code) VALUES (?, ?, 'sup', ?);`,
        [`sp-${tag}`, itemId, `code-${tag}`],
      );
    },
    kitMemberships: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO kit_components (id, kit_item_id, component_item_id) VALUES (?, 'kit', ?);`,
        [`kc-in-${tag}`, itemId],
      );
    },
    kitContents: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO kit_components (id, kit_item_id, component_item_id) VALUES (?, ?, 'part');`,
        [`kc-of-${tag}`, itemId],
      );
    },
    relations: async (itemId, tag) => {
      await driver.execute(
        `INSERT INTO item_relations (id, from_item_id, to_item_id, kind) VALUES (?, ?, 'other', 'REQUIRES');`,
        [`${itemId}|other|REQUIRES-${tag}`, itemId],
      );
    },
    variants: async (itemId, tag) => {
      const child = await items.create({ name: `Variant ${tag}`, locationId: UNASSIGNED_LOCATION_ID });
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', [itemId, child.id]);
    },
  };

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    tombstones = new TombstoneRepository(driver);

    keep = (await items.create({ name: 'Socket screw', locationId: UNASSIGNED_LOCATION_ID })).id;
    gone = (await items.create({ name: 'SOCKET SCREW', locationId: UNASSIGNED_LOCATION_ID })).id;
    // Fixed ids the seeders above hang their rows from.
    for (const name of ['kit', 'part', 'other']) {
      await driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
        name,
        `Fixture ${name}`,
        UNASSIGNED_LOCATION_ID,
      ]);
    }
    await driver.execute("INSERT INTO projects (id, name) VALUES ('proj', 'Bench');");
    await driver.execute("INSERT INTO suppliers (id, name, name_key) VALUES ('sup', 'Acme', 'acme');");
    await driver.execute("INSERT INTO purchase_orders (id, supplier_id) VALUES ('po', 'sup');");
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('findDuplicates', () => {
    it('finds the two items whose names fold to one key', async () => {
      const scan = await items.findDuplicates({ signals: ['name'] });
      expect(scan.groups).toHaveLength(1);
      expect(scan.groups[0]!.members.map((m) => m.id).sort()).toEqual([keep, gone].sort());
      expect(scan.truncated).toBe(false);
      expect(scan.scanned).toBe(scan.total);
    });

    it('resolves each member’s location, and its short number, for display', async () => {
      // The short number is what tells two members of a group apart on screen, since they share
      // a name by construction.
      await driver.execute('UPDATE items SET serial_no = 42 WHERE id = ?;', [keep]);
      const scan = await items.findDuplicates({ signals: ['name'] });
      const kept = scan.groups[0]!.members.find((m) => m.id === keep)!;
      expect(kept.locationName).toBeTruthy();
      expect(kept.serialNo).toBe(42);
    });

    it('ignores items that are already removed', async () => {
      await items.softDelete(gone);
      expect((await items.findDuplicates({ signals: ['name'] })).groups).toEqual([]);
    });
  });

  describe('countItemReferences', () => {
    it('returns an all-zero tally for an item nothing names', async () => {
      const counts = (await items.countItemReferences([keep])).get(keep)!;
      expect(totalItemReferences(counts)).toBe(0);
    });

    it('counts one row of every kind', async () => {
      for (const spec of ITEM_REFERENCE_SPECS) await seeders[spec.kind](gone, 'g');
      const counts = (await items.countItemReferences([gone])).get(gone)!;
      for (const spec of ITEM_REFERENCE_SPECS) {
        expect(counts[spec.kind], `kind ${spec.kind}`).toBe(1);
      }
    });
  });

  describe('mergeItems', () => {
    it('moves every kind of reference onto the kept item and leaves none behind', async () => {
      for (const spec of ITEM_REFERENCE_SPECS) await seeders[spec.kind](gone, 'g');

      const result = await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });

      const after = await items.countItemReferences([keep, gone]);
      for (const spec of ITEM_REFERENCE_SPECS) {
        // The drift assertion: every kind the tally knows about is a kind the merge moved.
        expect(after.get(gone)![spec.kind], `${spec.kind} left on the removed item`).toBe(0);
        expect(after.get(keep)![spec.kind], `${spec.kind} missing from the kept item`).toBe(1);
        expect(result.remapped[spec.kind], `${spec.kind} not reported as moved`).toBe(1);
      }
      expect(totalItemReferences(result.discarded)).toBe(0);
    });

    it('marks the removed item as removed, keeping it restorable', async () => {
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect((await items.getById(gone))!.isActive).toBe(false);
      expect((await items.getById(keep))!.isActive).toBe(true);

      const restored = await items.restore(gone);
      expect(restored.isActive).toBe(true);
    });

    it('does not tombstone the removed item — it is soft-deleted, not purged', async () => {
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect(await tombstones.listAll()).toEqual([]);
    });

    it('records the merge in both items’ Activity Logs', async () => {
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      const goneLog = await items.getHistory(gone);
      const keepLog = await items.getHistory(keep);
      expect(goneLog.rows[0]!.action).toBe('MERGED');
      expect(goneLog.rows[0]!.metadata).toMatchObject({ mergedIntoItemId: keep });
      expect(keepLog.rows[0]!.action).toBe('MERGED');
      expect(keepLog.rows[0]!.metadata).toMatchObject({ mergedFromItemId: gone });
    });

    it('leaves references alone when the caller does not ask for them', async () => {
      await seeders.checkouts(gone, 'g');
      const result = await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: false });
      expect(totalItemReferences(result.remapped)).toBe(0);
      expect((await items.countItemReferences([gone])).get(gone)!.checkouts).toBe(1);
      expect((await items.getById(gone))!.isActive).toBe(false);
    });

    it('refuses to merge an item into itself', async () => {
      await expect(items.mergeItems({ keepId: keep, removeId: keep, remapReferences: true })).rejects.toThrow(
        /itself/,
      );
    });

    it('refuses an item that does not exist, changing nothing', async () => {
      await expect(
        items.mergeItems({ keepId: keep, removeId: 'nope', remapReferences: true }),
      ).rejects.toThrow();
      expect((await items.getById(keep))!.isActive).toBe(true);
    });

    it('drops a kit edge the kept item already has, and reports it as discarded', async () => {
      await seeders.kitMemberships(keep, 'k');
      await seeders.kitMemberships(gone, 'g');
      const result = await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect(result.discarded.kitMemberships).toBe(1);
      expect(result.remapped.kitMemberships).toBe(0);
      const rows = await driver.query('SELECT id FROM kit_components;');
      expect(rows).toHaveLength(1);
    });

    it('re-keys a moved relation so its id still describes its endpoints', async () => {
      await seeders.relations(gone, 'g');
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      const rows = await driver.query<{ id: string; from_item_id: string }>(
        'SELECT id, from_item_id FROM item_relations;',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.from_item_id).toBe(keep);
      expect(rows[0]!.id).toBe(`${keep}|other|REQUIRES`);
    });

    it('tombstones a relation whose old id it replaced, so the removal propagates', async () => {
      await seeders.relations(gone, 'g');
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect(await tombstones.listAll()).toEqual([
        expect.objectContaining({ tableName: 'item_relations', id: `${gone}|other|REQUIRES-g` }),
      ]);
    });

    it('demotes a supplier-part flag the kept item already holds, rather than aborting', async () => {
      for (const [id, itemId] of [
        ['sp-keep', () => keep],
        ['sp-gone', () => gone],
      ] as const) {
        await driver.execute(
          `INSERT INTO supplier_parts (id, item_id, supplier_id, order_code, is_preferred, is_price_source)
           VALUES (?, ?, 'sup', ?, 1, 1);`,
          [id, itemId(), id],
        );
      }

      const result = await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });

      expect(result.demotedSupplierFlags).toBe(2); // one preferred, one price source
      const rows = await driver.query<{ id: string; is_preferred: number; is_price_source: number }>(
        'SELECT id, is_preferred, is_price_source FROM supplier_parts ORDER BY id;',
      );
      expect(rows).toEqual([
        { id: 'sp-gone', is_preferred: 0, is_price_source: 0 },
        { id: 'sp-keep', is_preferred: 1, is_price_source: 1 },
      ]);
    });

    it('re-parents the removed item’s variants and logs the move in each child’s own record', async () => {
      const child = await items.create({ name: 'Variant', locationId: UNASSIGNED_LOCATION_ID });
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', [gone, child.id]);

      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });

      expect((await items.getById(child.id))!.parentId).toBe(keep);
      // `VARIANT_RE_PARENTED`, never `RE_PARENTED`: the latter means "its location was removed
      // under it" and publishes as `item.moved`, which nothing here did.
      expect((await items.getHistory(child.id)).rows[0]!.action).toBe('VARIANT_RE_PARENTED');
    });

    it('never leaves the kept item parented to the item it absorbed', async () => {
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', [gone, keep]);
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect((await items.getById(keep))!.parentId).toBeNull();
    });

    it('accounts for every reference it was shown, keeper-as-child included', async () => {
      // The keeper hanging below the removed item is a `variants` reference like any other: the
      // preview counted it, so the outcome has to say what happened to it.
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', [gone, keep]);
      const before = (await items.countItemReferences([gone])).get(gone)!;
      expect(before.variants).toBe(1);

      const result = await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });

      expect(result.remapped.variants + result.discarded.variants).toBe(before.variants);
      expect((await items.getHistory(keep)).rows.map((r) => r.action)).toContain('VARIANT_RE_PARENTED');
    });

    it('inherits the removed item’s own parent when the keeper hung below it', async () => {
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', [gone, keep]);
      await driver.execute('UPDATE items SET parent_id = ? WHERE id = ?;', ['part', gone]);
      await items.mergeItems({ keepId: keep, removeId: gone, remapReferences: true });
      expect((await items.getById(keep))!.parentId).toBe('part');
    });
  });

  describe('findSimilarlyNamed', () => {
    it('reports a stored name that folds onto the typed one as exact', async () => {
      const matches = await items.findSimilarlyNamed('socket screw');
      expect(matches.map((m) => m.exact)).toEqual([true, true]);
      expect(matches.map((m) => m.id).sort()).toEqual([keep, gone].sort());
    });

    it('reports a near-miss as similar rather than exact', async () => {
      await items.create({ name: 'Socket screws', locationId: UNASSIGNED_LOCATION_ID });
      const matches = await items.findSimilarlyNamed('Socket screws');
      expect(matches.find((m) => m.name === 'Socket screws')!.exact).toBe(true);
      expect(matches.find((m) => m.name === 'Socket screw')!.exact).toBe(false);
    });

    it('says nothing about an unrelated name', async () => {
      expect(await items.findSimilarlyNamed('Hammer')).toEqual([]);
    });

    it('ignores removed items', async () => {
      await items.softDelete(keep);
      await items.softDelete(gone);
      expect(await items.findSimilarlyNamed('Socket screw')).toEqual([]);
    });

    it('asks nothing of the database for a value too short to narrow on', async () => {
      expect(await items.findSimilarlyNamed('S')).toEqual([]);
      expect(await items.findSimilarlyNamed('   ')).toEqual([]);
    });
  });
});
