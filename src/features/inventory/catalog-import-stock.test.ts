/**
 * An import that matches an existing item must move the stock and the item it says it will
 * (issue #592).
 *
 * `items.quantity` is derived from the `item_stock` ledger by trigger and `location_id` moves
 * only with the placements it summarises, so neither is a field on `UpdateItemInput`. The
 * importer used to show both in its preview and write neither — the preview said "Qty 250,
 * update", the summary said "1 updated", and the item still held what it always had.
 *
 * These tests drive the real `ItemRepository` against a `:memory:` database, because the whole
 * defect lived in the gap between what the plan promised and what the repository could do: a
 * stub that accepts whatever it is handed would have passed the broken code too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { LocationRepository } from '@/db/repositories/LocationRepository';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { Item, TrackingMode } from '@/db/repositories/types';
import { buildCatalogImportPlan, applyCatalogImportPlan } from './catalog-import';
import { buildPreviewRows } from './text-import';

describe('an import applies the quantity and location it previews', () => {
  let driver: MemoryDriver;
  let repo: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    repo = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  /** Import `csv` against the catalogue as it stands, and return the plan and the result. */
  async function importAgainst(csv: string, existing: readonly Item[], workshopId?: string) {
    const plan = buildCatalogImportPlan(csv, null, existing, {
      ...(workshopId
        ? {
            locations: [
              { id: workshopId, name: 'Workshop' },
              { id: UNASSIGNED_LOCATION_ID, name: 'Unassigned' },
            ],
          }
        : {}),
    });
    return { plan, result: await applyCatalogImportPlan(plan, repo) };
  }

  it('raises a matched item to the quantity the file states', async () => {
    const item = await repo.create({ name: 'Widget A', quantity: 200 });
    const { result } = await importAgainst('name,quantity\r\nWidget A,250\r\n', [item]);

    expect(result.updated).toBe(1);
    expect(result.rows[0]!.error).toBeUndefined();
    expect((await repo.getById(item.id))!.quantity).toBe(250);
  });

  it('lowers it just as readily — a stock-take that found fewer', async () => {
    const item = await repo.create({ name: 'Widget A', quantity: 200 });
    await importAgainst('name,quantity\r\nWidget A,7\r\n', [item]);

    expect((await repo.getById(item.id))!.quantity).toBe(7);
  });

  it("records the change in the item's history, naming the import", async () => {
    const item = await repo.create({ name: 'Widget A', quantity: 200 });
    await importAgainst('name,quantity\r\nWidget A,250\r\n', [item]);

    const history = (await repo.getHistory(item.id)).rows;
    const entry = history.find((h) => h.action === 'QUANTITY_CHANGE');
    expect(entry).toBeDefined();
    expect(entry!.quantityDelta).toBe(50);
    expect(entry!.note).toContain('import');
  });

  it('leaves the stock alone when the file states the count it already holds', async () => {
    // The shape of an exported catalogue coming back in: nothing changed, so nothing is logged.
    const item = await repo.create({ name: 'Widget A', quantity: 200 });
    const { plan } = await importAgainst('name,quantity,unitCost\r\nWidget A,200,1.50\r\n', [item]);

    expect(plan.update[0]!.stock).toBeUndefined();
    const history = (await repo.getHistory(item.id)).rows;
    expect(history.some((h) => h.action === 'QUANTITY_CHANGE')).toBe(false);
  });

  it('moves a matched item to the location its own cell names', async () => {
    const workshop = await locations.create({ name: 'Workshop' });
    const item = await repo.create({ name: 'Widget A', quantity: 5 });
    expect(item.locationId).toBe(UNASSIGNED_LOCATION_ID);

    const { result } = await importAgainst('name,location\r\nWidget A,Workshop\r\n', [item], workshop.id);

    expect(result.rows[0]!.error).toBeUndefined();
    expect((await repo.getById(item.id))!.locationId).toBe(workshop.id);
  });

  it('lands the new units at the location the same row moved the item to', async () => {
    const workshop = await locations.create({ name: 'Workshop' });
    const item = await repo.create({ name: 'Widget A', quantity: 5 });

    await importAgainst('name,quantity,location\r\nWidget A,12,Workshop\r\n', [item], workshop.id);

    const updated = (await repo.getById(item.id))!;
    expect(updated.quantity).toBe(12);
    expect(updated.locationId).toBe(workshop.id);
    const placements = await repo.listStock(item.id);
    expect(placements).toEqual([expect.objectContaining({ locationId: workshop.id, quantity: 12 })]);
  });

  it('counts a split item down after gathering it, not before', async () => {
    // Why the move runs first: `adjustQuantity` draws a shortfall out of the item's *primary*
    // location only. An item split across two drawers holds less there than the whole shortfall,
    // so counting before gathering asks for units that placement does not have — and the row's
    // count, the one the preview promised, never lands.
    const workshop = await locations.create({ name: 'Workshop' });
    const item = await repo.create({ name: 'Widget A', quantity: 12 });
    await repo.transferStock(item.id, UNASSIGNED_LOCATION_ID, workshop.id, 7);

    const { result } = await importAgainst(
      'name,quantity,location\r\nWidget A,3,Workshop\r\n',
      [(await repo.getById(item.id))!],
      workshop.id,
    );

    expect(result.rows[0]!.error).toBeUndefined();
    const updated = (await repo.getById(item.id))!;
    expect(updated.quantity).toBe(3);
    expect(await repo.listStock(item.id)).toEqual([
      expect.objectContaining({ locationId: workshop.id, quantity: 3 }),
    ]);
  });

  it('does not move a matched item to the batch default location it never asked for', async () => {
    // The dialog's Location dropdown answers "where do the NEW items go?". Reading it as a move
    // would relocate a whole catalogue on an import that never mentioned locations.
    const workshop = await locations.create({ name: 'Workshop' });
    const item = await repo.create({ name: 'Widget A', quantity: 5 });

    const plan = buildCatalogImportPlan('name,unitCost\r\nWidget A,2.00\r\nNew Part,3.00\r\n', null, [item], {
      locations: [{ id: workshop.id, name: 'Workshop' }],
      defaultLocationId: workshop.id,
    });
    await applyCatalogImportPlan(plan, repo);

    expect(plan.update[0]!.moveToLocationId).toBeUndefined();
    expect((await repo.getById(item.id))!.locationId).toBe(UNASSIGNED_LOCATION_ID);
    // The default still places the created row, which is what it is for.
    expect(plan.create[0]!.input.locationId).toBe(workshop.id);
  });

  it('previews the change against what the item holds now, not the bare cell', async () => {
    const item = await repo.create({ name: 'Widget A', quantity: 200 });
    const csv = 'name,quantity\r\nWidget A,250\r\nNew Part,9\r\n';
    const plan = buildCatalogImportPlan(csv, null, [item]);
    const rows = buildPreviewRows(
      [
        ['Widget A', '250'],
        ['New Part', '9'],
      ],
      ['name', 'quantity'],
      plan,
    );

    expect(rows[0]).toMatchObject({ status: 'update', quantityChange: { from: 200, to: 250 } });
    // A create has nothing to compare against — the cell is the whole story.
    expect(rows[1]).toMatchObject({ status: 'create', quantity: '9' });
    expect(rows[1]!.quantityChange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Drift test: the dry-run guard vs `adjustQuantity`'s own tracking-mode rule
// ---------------------------------------------------------------------------

/**
 * The plan builder refuses a quantity change on a non-DISCRETE item so the preview can say why,
 * which restates a rule `ItemRepository.adjustQuantity` enforces for itself. Prose cannot hold
 * the two together, so this drives both sides and compares the verdicts (see CLAUDE.md, "a
 * mirrors X comment is a request for a test"): for each tracking mode, the row is planned as an
 * error exactly when the repository would refuse the same adjustment.
 */
describe("the import's quantity guard agrees with the repository", () => {
  let driver: MemoryDriver;
  let repo: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    repo = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  const MODES: readonly TrackingMode[] = ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE', 'UNTRACKED'];

  it.each(MODES)('%s', async (mode) => {
    const item = await repo.create({
      name: 'Widget A',
      trackingMode: mode,
      quantity: 1,
      ...(mode === 'CONSUMABLE_GAUGE' ? { gauge: { unitOfMeasure: 'ml', grossCapacity: 500 } } : {}),
    });

    // The repository's own verdict on the very adjustment this row implies.
    let repositoryRefused = false;
    try {
      await repo.adjustQuantity(item.id, 1, 'parity probe');
    } catch {
      repositoryRefused = true;
    }

    const plan = buildCatalogImportPlan('name,quantity\r\nWidget A,2\r\n', null, [item]);
    const plannerRefused = plan.errors.length > 0;

    expect(plannerRefused).toBe(repositoryRefused);
  });
});
