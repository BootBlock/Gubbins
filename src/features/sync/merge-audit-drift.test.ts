/**
 * The merge-overwrite registry against the two things it must not drift from (issue #487).
 *
 * `merge-audit.ts` keeps its own list of the `items` columns whose loss is worth recording,
 * because reconciliation works on raw snapshot rows and never goes through `ItemRepository`.
 * A second list of the same thing is exactly the sort that rots quietly: a field added to the
 * edit path's audit would keep raising `ATTRIBUTES_CHANGED` entries while a merge went on
 * discarding it in silence — the very fault this issue closes, re-opened one column at a time.
 *
 * These two tests hold it against both neighbours: the fields `ItemRepository.update` actually
 * audits, and the live `items` schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from '@/db/repositories/CategoryRepository';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { AUDITED_ITEM_FIELDS } from './merge-audit';

/**
 * The fields the edit path audits under its own dedicated action rather than through
 * `ATTRIBUTES_CHANGED`'s `fields` list — a rename, a tracking-mode swap and a condition change
 * each write their own entry. A merge writes one entry for the whole overwrite, so the registry
 * carries them as ordinary fields and this test adds them back before comparing.
 */
const DEDICATED_ACTION_FIELDS = ['name', 'trackingMode', 'condition'];

/**
 * `items` columns the registry deliberately omits, with the reason. Every column not audited
 * must be named here, so adding one to the schema forces the decision instead of defaulting to
 * silence.
 */
const UNAUDITED_COLUMNS: Record<string, string> = {
  id: 'the row identity itself; it cannot be overwritten by an upsert keyed on it',
  created_at: 'bookkeeping, never a user edit',
  updated_at: 'bookkeeping — it is how the merge decided the winner in the first place',
  description: 'free-form prose the edit path leaves silent (a before/after copy would bloat the ledger)',
  notes: 'free-form prose, as above',
  operational_metadata: 'a schema-less map the edit path leaves silent',
  is_favourite: 'a reporting preference, deliberately history-free',
  is_unlimited: 'a reporting preference, deliberately history-free',
  dead_stock_mode: 'a reporting preference, deliberately history-free',
  quantity: 'trigger-derived from the `item_stock` ledger; not decided by this upsert',
  current_net_value: 'merged by the §7.3 gauge Delta-CRDT, not by last-write-wins',
  location_id: 'moved by its own paths (`MOVED`, and the §7.5.2 re-parent log)',
  parent_id: 'the variant hierarchy, reshaped by its own path (`VARIANT_CREATED`)',
  is_active: 'the soft-delete state, with its own actions (`SOFT_DELETED` / `RESTORED`)',
  serial_no: 'set once when a serialised unit is created; the edit path does not change it',
  unit_of_measure: 'gauge geometry, configured rather than edited (the edit path leaves it silent)',
  gross_capacity: 'gauge geometry, as above',
  tare_weight: 'gauge geometry, as above',
  attrition_percent: 'gauge geometry, as above',
};

describe('the merge-overwrite registry (issue #487)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('records exactly the fields the edit path audits', async () => {
    // Two items, because two of the audited fields are mutually exclusive by tracking mode: only
    // a gauge has a cost per unit of measure, and only a DISCRETE item can be switched in place.
    const category = await new CategoryRepository(driver).create({ name: 'Power tools' });
    const discrete = await items.create({ name: 'Drill', quantity: 1 });
    await items.update(discrete.id, {
      name: 'Hammer drill',
      trackingMode: 'UNTRACKED',
      condition: 'GOOD',
      categoryId: category.id,
      mpn: 'MPN-77',
      manufacturer: 'Example Works',
      barcode: '5012345678900',
      serialNumber: 'SN-0042',
      unitCost: 3.75,
      expiryDate: 1_800_000_000_000,
      batchNumber: 'B-12',
      lotNumber: 'L-9',
      reorderPoint: 5,
      reorderGaugePercent: 20,
      reorderQty: 10,
      acquiredAt: '2026-03-04',
      warrantyExpiresAt: '2028-03-04',
      purchasePrice: 19.99,
      depreciationMonths: 36,
      weight: 250,
      width: 10,
      height: 20,
      depth: 30,
      currentValue: 12,
    });

    const gauge = await items.create({
      name: 'Solvent',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'ml', grossCapacity: 1000, currentNetValue: 1000 },
    });
    await items.update(gauge.id, { costPerUnitOfMeasure: 0.02 });

    const audited = new Set(DEDICATED_ACTION_FIELDS);
    for (const id of [discrete.id, gauge.id]) {
      const history = await items.getHistory(id);
      for (const entry of history.rows) {
        if (entry.action !== 'ATTRIBUTES_CHANGED') continue;
        for (const field of (entry.metadata?.fields ?? []) as string[]) audited.add(field);
      }
    }

    expect([...audited].sort()).toEqual([...AUDITED_ITEM_FIELDS].sort());
  });

  it('has a decision on record for every column of the live `items` table', async () => {
    const columns = await driver.query<{ name: string }>('PRAGMA table_info(items);');
    const registered = new Set(
      [...AUDITED_ITEM_FIELDS].map((f) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)),
    );

    const undecided = columns
      .map((c) => c.name)
      .filter((name) => !registered.has(name) && !(name in UNAUDITED_COLUMNS));

    expect(undecided).toEqual([]);
  });
});
