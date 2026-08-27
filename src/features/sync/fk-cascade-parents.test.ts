import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import type { SqlRow } from '@/db/rpc/driver';
import type { ItemRegionEdge, SyncSnapshot, TableRow, Tombstone } from './types';

/**
 * Issue #536: the `FK_REFS` parents whose removed-id set the merge did not build correctly.
 *
 * `enforceForeignKeys` treats a parent with no removed-id set as intact, so the `location_photos`
 * and `project_budget_categories` entries were dead code outright: the merge re-downloaded a child
 * of a locally-deleted parent and the atomic apply aborted on `FOREIGN KEY constraint failed`,
 * repeating on every retry because the watermark never advanced. `supplier_parts` had a set, but
 * built it the same wrong way.
 *
 * All three are themselves cascade children, so their removed set has to fold in the sweep the
 * tombstone does not record — §7.2 tombstones the parent only. `fk-refs.test.ts` derives that
 * requirement from the schema, so a fourth such parent is guarded the moment it exists; these
 * cover the concrete behaviour each entry was always meant to have.
 */

// Permissive enough that sanitisation keeps the columns asserted on below.
const DICTIONARY = {
  locations: ['id', 'name', 'parent_id', 'updated_at'],
  suppliers: ['id', 'name', 'updated_at'],
  supplier_parts: ['id', 'item_id', 'supplier_id', 'updated_at'],
  supplier_part_price_history: ['id', 'supplier_part_id', 'unit_cost', 'updated_at'],
  purchase_orders: ['id', 'supplier_id', 'updated_at'],
  purchase_order_lines: ['id', 'po_id', 'item_id', 'supplier_part_id', 'updated_at'],
  location_photos: ['id', 'location_id', 'caption', 'updated_at'],
  location_regions: ['id', 'photo_id', 'name', 'updated_at'],
  projects: ['id', 'name', 'updated_at'],
  project_budget_categories: ['id', 'project_id', 'name', 'updated_at'],
  project_expenses: ['id', 'project_id', 'category_id', 'amount', 'updated_at'],
  items: ['id', 'name', 'location_id', 'updated_at'],
};

function snapshot(partial: {
  tables?: Partial<Record<string, SqlRow[]>>;
  tombstones?: Tombstone[];
  itemRegions?: ItemRegionEdge[];
}): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables: partial.tables ?? {},
    tombstones: partial.tombstones ?? [],
    gaugeHistory: [],
    itemTags: [],
    locationTags: [],
    itemRegions: partial.itemRegions ?? [],
    itemHistory: [],
    stockDeltas: [],
  };
}

const opts = { offset: 0, dictionary: DICTIONARY };

/** The ids a plan will upsert into `table`. */
const upsertedIds = (upserts: readonly TableRow[], table: string): string[] =>
  upserts.filter((u) => u.table === table).map((u) => String(u.row.id));

describe('removed-parent sets for the cascade parents (#536)', () => {
  it('drops a region whose photo this device deleted', () => {
    // A deletes photo P1; the cascade removed R1 locally but only P1 is tombstoned. B still
    // holds both, so R1 comes back as "new on the remote" with nothing to stop it.
    const local = snapshot({
      tables: { locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }] },
      tombstones: [{ tableName: 'location_photos', id: 'P1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        location_photos: [{ id: 'P1', location_id: 'L1', caption: null, updated_at: 5 }],
        location_regions: [{ id: 'R1', photo_id: 'P1', name: 'Top shelf', updated_at: 5 }],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'location_photos')).toEqual([]); // the tombstone wins
    expect(upsertedIds(plan.localUpserts, 'location_regions')).toEqual([]);
  });

  it('drops a photo and its region when the location itself did not survive', () => {
    // The two-deep chain: the location tombstone sweeps the photo, which sweeps the region.
    const local = snapshot({
      tombstones: [{ tableName: 'locations', id: 'L1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 5 }],
        location_photos: [{ id: 'P1', location_id: 'L1', caption: null, updated_at: 5 }],
        location_regions: [{ id: 'R1', photo_id: 'P1', name: 'Top shelf', updated_at: 5 }],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'locations')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'location_photos')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'location_regions')).toEqual([]);
  });

  it('keeps a region whose photo survives', () => {
    // The guard must not over-reach: an unrelated deletion leaves the rest of the photo intact.
    const local = snapshot({
      tables: { locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }] },
      tombstones: [{ tableName: 'location_photos', id: 'P2', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        location_photos: [{ id: 'P1', location_id: 'L1', caption: null, updated_at: 5 }],
        location_regions: [{ id: 'R1', photo_id: 'P1', name: 'Top shelf', updated_at: 5 }],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'location_photos')).toEqual(['P1']);
    expect(upsertedIds(plan.localUpserts, 'location_regions')).toEqual(['R1']);
  });

  it('drops an item-to-region placement whose photo this device deleted', () => {
    // The bespoke `item_regions` join takes the same cascade: its region_id is NOT NULL /
    // ON DELETE CASCADE, so re-inserting the edge would trip the same foreign key.
    const local = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
      },
      tombstones: [{ tableName: 'location_photos', id: 'P1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
        location_photos: [{ id: 'P1', location_id: 'L1', caption: null, updated_at: 5 }],
        location_regions: [{ id: 'R1', photo_id: 'P1', name: 'Top shelf', updated_at: 5 }],
      },
      itemRegions: [{ itemId: 'I1', regionId: 'R1' }],
    });

    const plan = reconcile(local, remote, opts);
    expect(plan.itemRegionUpserts).toEqual([]);
  });

  it('drops an item-to-region placement whose photo a peer deleted', () => {
    // The mirror image, and the case the `finalRegionIds` filter alone answers: the photo is
    // removed by the *remote* tombstone, so this device still stores photo, region and edge. The
    // apply deletes P1 and SQLite cascades R1 away, so re-asserting the edge would trip its FK.
    const local = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
        location_photos: [{ id: 'P1', location_id: 'L1', caption: null, updated_at: 1 }],
        location_regions: [{ id: 'R1', photo_id: 'P1', name: 'Top shelf', updated_at: 1 }],
      },
      itemRegions: [{ itemId: 'I1', regionId: 'R1' }],
    });
    const remote = snapshot({
      tables: {
        locations: [{ id: 'L1', name: 'Shed', parent_id: null, updated_at: 1 }],
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
      },
      tombstones: [{ tableName: 'location_photos', id: 'P1', deletedAt: 10 }],
      itemRegions: [{ itemId: 'I1', regionId: 'R1' }],
    });

    const plan = reconcile(local, remote, opts);
    expect(plan.localDeletes).toContainEqual({
      tableName: 'location_photos',
      id: 'P1',
      deletedAt: 10,
    });
    expect(plan.itemRegionUpserts).toEqual([]);
  });

  it('drops a price point whose supplier part died with its supplier', () => {
    // `supplier_parts` is a cascade child of both its item and its supplier, so its removed set
    // needs the same fold. Deleting the supplier sweeps the part away untombstoned; without the
    // fold the part reads as alive and its price history is re-inserted against nothing.
    const local = snapshot({
      tables: { items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }] },
      tombstones: [{ tableName: 'suppliers', id: 'S1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
        suppliers: [{ id: 'S1', name: 'Acme Tools', updated_at: 5 }],
        supplier_parts: [{ id: 'SP1', item_id: 'I1', supplier_id: 'S1', updated_at: 5 }],
        supplier_part_price_history: [
          { id: 'PH1', supplier_part_id: 'SP1', unit_cost: 1_500_000, updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'suppliers')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'supplier_parts')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'supplier_part_price_history')).toEqual([]);
  });

  it('clears a purchase-order line pointing at a supplier part that died with its item', () => {
    // The other parent of the same table, and the nullable child: an order line is a record of
    // money spent, so it keeps its row with `supplier_part_id` cleared (ON DELETE SET NULL).
    const local = snapshot({
      tombstones: [{ tableName: 'items', id: 'I1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 5 }],
        suppliers: [{ id: 'S1', name: 'Acme Tools', updated_at: 5 }],
        supplier_parts: [{ id: 'SP1', item_id: 'I1', supplier_id: 'S1', updated_at: 5 }],
        purchase_orders: [{ id: 'PO1', supplier_id: 'S1', updated_at: 5 }],
        purchase_order_lines: [
          { id: 'POL1', po_id: 'PO1', item_id: null, supplier_part_id: 'SP1', updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'supplier_parts')).toEqual([]);
    const line = plan.localUpserts.find((u) => u.table === 'purchase_order_lines');
    expect(line?.row).toMatchObject({ id: 'POL1', po_id: 'PO1', supplier_part_id: null });
  });

  it('keeps a supplier part whose item and supplier both survive', () => {
    const local = snapshot({
      tables: { items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }] },
      tombstones: [{ tableName: 'suppliers', id: 'S2', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        items: [{ id: 'I1', name: 'Drill', location_id: 'L1', updated_at: 1 }],
        suppliers: [{ id: 'S1', name: 'Acme Tools', updated_at: 5 }],
        supplier_parts: [{ id: 'SP1', item_id: 'I1', supplier_id: 'S1', updated_at: 5 }],
        supplier_part_price_history: [
          { id: 'PH1', supplier_part_id: 'SP1', unit_cost: 1_500_000, updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'supplier_parts')).toEqual(['SP1']);
    expect(upsertedIds(plan.localUpserts, 'supplier_part_price_history')).toEqual(['PH1']);
  });

  it('clears an expense reference to a removed budget category rather than dropping the spend', () => {
    // `project_expenses.category_id` is ON DELETE SET NULL, so the spend is real and survives —
    // it just falls back to uncategorised, which is what `removeBudgetCategory` promises.
    const local = snapshot({
      tables: { projects: [{ id: 'PR1', name: 'Kitchen', updated_at: 1 }] },
      tombstones: [{ tableName: 'project_budget_categories', id: 'C1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        projects: [{ id: 'PR1', name: 'Kitchen', updated_at: 1 }],
        project_budget_categories: [{ id: 'C1', project_id: 'PR1', name: 'Timber', updated_at: 5 }],
        project_expenses: [
          { id: 'E1', project_id: 'PR1', category_id: 'C1', amount: 1_000_000, updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'project_budget_categories')).toEqual([]);
    const expense = plan.localUpserts.find((u) => u.table === 'project_expenses');
    expect(expense?.row).toMatchObject({ id: 'E1', category_id: null, amount: 1_000_000 });
  });

  it('drops a budget category and its expenses when the project did not survive', () => {
    // The project cascade one level over: neither the category nor the expense can outlive the
    // project (both project_id columns are NOT NULL / ON DELETE CASCADE).
    const local = snapshot({
      tombstones: [{ tableName: 'projects', id: 'PR1', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        projects: [{ id: 'PR1', name: 'Kitchen', updated_at: 5 }],
        project_budget_categories: [{ id: 'C1', project_id: 'PR1', name: 'Timber', updated_at: 5 }],
        project_expenses: [
          { id: 'E1', project_id: 'PR1', category_id: 'C1', amount: 1_000_000, updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'projects')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'project_budget_categories')).toEqual([]);
    expect(upsertedIds(plan.localUpserts, 'project_expenses')).toEqual([]);
  });

  it('keeps an expense whose category survives', () => {
    const local = snapshot({
      tables: { projects: [{ id: 'PR1', name: 'Kitchen', updated_at: 1 }] },
      tombstones: [{ tableName: 'project_budget_categories', id: 'C2', deletedAt: 10 }],
    });
    const remote = snapshot({
      tables: {
        projects: [{ id: 'PR1', name: 'Kitchen', updated_at: 1 }],
        project_budget_categories: [{ id: 'C1', project_id: 'PR1', name: 'Timber', updated_at: 5 }],
        project_expenses: [
          { id: 'E1', project_id: 'PR1', category_id: 'C1', amount: 1_000_000, updated_at: 5 },
        ],
      },
    });

    const plan = reconcile(local, remote, opts);
    expect(upsertedIds(plan.localUpserts, 'project_budget_categories')).toEqual(['C1']);
    const expense = plan.localUpserts.find((u) => u.table === 'project_expenses');
    expect(expense?.row).toMatchObject({ id: 'E1', category_id: 'C1' });
  });
});
