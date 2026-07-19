import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository } from './ItemRepository';
import { LocationRepository } from './LocationRepository';
import { UNASSIGNED_LOCATION_ID } from './constants';

describe('ItemRepository', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates a discrete item defaulting to Unassigned and logs CREATED', async () => {
    const item = await items.create({ name: 'M3 Screws', quantity: 200 });
    expect(item.locationId).toBe(UNASSIGNED_LOCATION_ID);
    expect(item.quantity).toBe(200);
    expect(item.trackingMode).toBe('DISCRETE');

    const history = await items.getHistory(item.id);
    expect(history.rows[0]?.action).toBe('CREATED');
  });

  it('forces SERIALISED items to quantity 1', async () => {
    const printer = await items.create({ name: 'Ender 3', trackingMode: 'SERIALISED', quantity: 5 });
    expect(printer.quantity).toBe(1);
  });

  it('paginates list reads and clamps the limit to 100', async () => {
    for (let i = 0; i < 5; i++) await items.create({ name: `Item ${i}` });
    const page = await items.list({ limit: 1000, offset: 0 });
    expect(page.limit).toBe(100);
    expect(page.rows).toHaveLength(5);
    expect(page.hasMore).toBe(false);

    const firstTwo = await items.list({ limit: 2 });
    expect(firstTwo.rows).toHaveLength(2);
    expect(firstTwo.hasMore).toBe(true);
  });

  it('defaults items to not-favourite and toggles the pin without a history entry', async () => {
    const item = await items.create({ name: 'Cordless drill' });
    expect(item.isFavourite).toBe(false);

    const starred = await items.update(item.id, { isFavourite: true });
    expect(starred.isFavourite).toBe(true);

    // Favouriting is a personal curation, not a change to the item — no ledger entry.
    const history = await items.getHistory(item.id);
    expect(history.rows.map((h) => h.action)).not.toContain('RENAMED');
    expect(history.rows.every((h) => h.action === 'CREATED')).toBe(true);

    const cleared = await items.update(item.id, { isFavourite: false });
    expect(cleared.isFavourite).toBe(false);
  });

  it('sorts favourited items ahead of everything else, whatever the sort', async () => {
    // Names are chosen so the favourite ("Zebra") would sort LAST alphabetically and the
    // default name order would otherwise bury it — proving favourites lead regardless.
    await items.create({ name: 'Apple' });
    await items.create({ name: 'Mango' });
    const zebra = await items.create({ name: 'Zebra' });
    await items.update(zebra.id, { isFavourite: true });

    const byName = await items.list();
    expect(byName.rows.map((i) => i.name)).toEqual(['Zebra', 'Apple', 'Mango']);

    // Even an explicit name-descending sort keeps the favourite pinned to the top.
    const byNameDesc = await items.list({ sort: [{ field: 'name', direction: 'desc' }] });
    expect(byNameDesc.rows[0]?.name).toBe('Zebra');
  });

  it('filters by location and active state', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    await items.create({ name: 'On shelf', locationId: shelf.id });
    const gone = await items.create({ name: 'Removed', locationId: shelf.id });
    await items.softDelete(gone.id);

    const active = await items.list({ locationId: shelf.id });
    expect(active.rows).toHaveLength(1);
    const all = await items.list({ locationId: shelf.id, includeInactive: true });
    expect(all.rows).toHaveLength(2);
  });

  it('adjusts discrete quantity and records the delta', async () => {
    const item = await items.create({ name: 'Resistors', quantity: 100 });
    const updated = await items.adjustQuantity(item.id, -30);
    expect(updated.quantity).toBe(70);

    const history = await items.getHistory(item.id);
    expect(history.rows[0]?.action).toBe('QUANTITY_CHANGE');
    expect(history.rows[0]?.quantityDelta).toBe(-30);
  });

  it('refuses to drive quantity below zero', async () => {
    const item = await items.create({ name: 'Caps', quantity: 5 });
    await expect(items.adjustQuantity(item.id, -10)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('moves an item and logs from/to in the ledger', async () => {
    const shelf = await locations.create({ name: 'Shelf' });
    const item = await items.create({ name: 'Box' });
    const moved = await items.move(item.id, shelf.id);
    expect(moved.locationId).toBe(shelf.id);

    const history = await items.getHistory(item.id);
    const moveEntry = history.rows.find((h) => h.action === 'MOVED');
    expect(moveEntry?.metadata).toMatchObject({
      fromLocationId: UNASSIGNED_LOCATION_ID,
      toLocationId: shelf.id,
    });
  });

  it('creates a consumable gauge and computes derived state (§4.1.1)', async () => {
    const spool = await items.create({
      name: 'PLA Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250 },
    });
    expect(spool.gauge?.currentNetValue).toBe(1000); // defaults to full
    expect(spool.gauge?.percentageRemaining).toBe(100);
    expect(spool.gauge?.currentGrossWeight).toBe(1250);
  });

  it('stores and clears §4.1.1 operational metadata on any item (not just gauges)', async () => {
    const item = await items.create({ name: 'Calipers' });
    expect(item.operationalMetadata).toBeNull();

    const updated = await items.update(item.id, {
      operationalMetadata: { calibration_interval_days: 365, last_calibrated_by: 'QA' },
    });
    expect(updated.operationalMetadata).toEqual({
      calibration_interval_days: 365,
      last_calibrated_by: 'QA',
    });

    // It survives a fresh read from the DB, not just the returned object.
    const reread = await items.getById(item.id);
    expect(reread?.operationalMetadata).toEqual({
      calibration_interval_days: 365,
      last_calibrated_by: 'QA',
    });

    // An empty record clears it back to SQL NULL.
    const cleared = await items.update(item.id, { operationalMetadata: {} });
    expect(cleared.operationalMetadata).toBeNull();
  });

  it('applies a relative gauge consumption and logs the net delta', async () => {
    const spool = await items.create({
      name: 'PETG',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 445 },
    });
    const after = await items.adjustGauge(spool.id, { delta: -45 });
    expect(after.gauge?.currentNetValue).toBe(400);

    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.action).toBe('GAUGE_UPDATE');
    expect(history.rows[0]?.netValueDelta).toBe(-45);
  });

  it('converts an absolute weigh-in to a relative delta before storing (§4.1.2)', async () => {
    const spool = await items.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 445 },
    });
    const after = await items.weighInGauge(spool.id, 650);
    expect(after.gauge?.currentNetValue).toBe(400);

    const history = await items.getHistory(spool.id);
    // The ledger stores the *relative* delta, never the absolute scale reading.
    expect(history.rows[0]?.netValueDelta).toBe(-45);
    expect(history.rows[0]?.note).toContain('Calibrated gross weight to 650g');
  });

  it('clamps gauge net value at zero', async () => {
    const spool = await items.create({
      name: 'Nearly empty',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 30 },
    });
    const after = await items.adjustGauge(spool.id, { delta: -100 });
    expect(after.gauge?.currentNetValue).toBe(0);
    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.netValueDelta).toBe(-30); // applied delta, clamped
  });

  it('clamps gauge net value at full capacity on an overfilled refill (§4.1.2)', async () => {
    const spool = await items.create({
      name: 'Refillable',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 400 },
    });
    // Adding 800 g would overfill (1200 g); the net is capped at the 1000 g capacity.
    const after = await items.adjustGauge(spool.id, { delta: 800 });
    expect(after.gauge?.currentNetValue).toBe(1000);
    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.netValueDelta).toBe(600); // applied delta, clamped to top-off
  });

  it('composes overlapping gauge adjusts instead of losing one (issue #297)', async () => {
    const spool = await items.create({
      name: 'Busy spool',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 1000 },
    });
    // Two adjusts in flight together — a second gauge surface, a bridge write — both read
    // the same starting value. An absolute write would let the second discard the first.
    await Promise.all([
      items.adjustGauge(spool.id, { delta: -40 }),
      items.adjustGauge(spool.id, { delta: -30 }),
    ]);

    const after = await items.getById(spool.id);
    expect(after?.gauge?.currentNetValue).toBe(930);

    // §7.3 replay rebuilds the value as `grossCapacity + Σ deltas`, so the ledger has to
    // agree with the row exactly — not merely record both events.
    const history = await items.getHistory(spool.id);
    const deltas = history.rows.filter((r) => r.action === 'GAUGE_UPDATE');
    expect(deltas).toHaveLength(2);
    expect(deltas.reduce((sum, r) => sum + (r.netValueDelta ?? 0), 0)).toBe(-70);
  });

  it('keeps the ledger honest when overlapping draws hit empty (issue #297)', async () => {
    const spool = await items.create({
      name: 'Nearly gone',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 50 },
    });
    // 80 g asked for from a gauge holding 50 g: the clamp cuts the pair short, and only
    // 50 g may be recorded as having moved.
    await Promise.all([
      items.adjustGauge(spool.id, { delta: -40 }),
      items.adjustGauge(spool.id, { delta: -40 }),
    ]);

    const after = await items.getById(spool.id);
    expect(after?.gauge?.currentNetValue).toBe(0);

    const history = await items.getHistory(spool.id);
    const deltas = history.rows.filter((r) => r.action === 'GAUGE_UPDATE');
    expect(deltas.reduce((sum, r) => sum + (r.netValueDelta ?? 0), 0)).toBe(-50);
  });

  it('does not let a reconfiguration revert a concurrent adjust (issue #297)', async () => {
    const drum = await items.create({
      name: 'Cable drum',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 100, tareWeight: 0, currentNetValue: 100 },
    });
    // Correcting the unit label moves no material, so it must leave the level alone —
    // including a draw that lands while the reconfigure dialog is open. The draw is listed
    // first deliberately: both calls await a single read before their transaction, so this
    // is the ordering where the reconfiguration writes last and an absolute write would
    // revert the draw. (Listed the other way round the bug hides.)
    await Promise.all([
      items.adjustGauge(drum.id, { delta: -25 }),
      items.reconfigureGauge(drum.id, { unitOfMeasure: 'm' }),
    ]);

    const after = await items.getById(drum.id);
    expect(after?.gauge?.unitOfMeasure).toBe('m');
    expect(after?.gauge?.currentNetValue).toBe(75);

    const history = await items.getHistory(drum.id);
    const deltas = history.rows.filter((r) => r.action === 'GAUGE_UPDATE');
    expect(deltas.reduce((sum, r) => sum + (r.netValueDelta ?? 0), 0)).toBe(-25);
  });

  it('records a spill a concurrent refill created during a shrink (issue #297)', async () => {
    const drum = await items.create({
      name: 'Shrinking drum',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 0, currentNetValue: 500 },
    });
    // Read against 500, shrinking to 750 spills nothing. A refill to 1000 landing first
    // makes it spill 250 for real — the ledger has to carry the spill that actually happened,
    // not the zero the pre-read predicted.
    await Promise.all([
      items.adjustGauge(drum.id, { delta: 500 }),
      items.reconfigureGauge(drum.id, { grossCapacity: 750 }),
    ]);

    const after = await items.getById(drum.id);
    expect(after?.gauge?.grossCapacity).toBe(750);
    expect(after?.gauge?.currentNetValue).toBe(750);

    // The deltas must account for every unit of the 500 → 750 move, whichever of the two
    // commits first: a +500 refill and a -250 spill, or a 0 spill and a +250 clamped refill.
    const history = await items.getHistory(drum.id);
    const deltas = history.rows.filter((r) => r.action === 'GAUGE_UPDATE');
    expect(deltas.reduce((sum, r) => sum + (r.netValueDelta ?? 0), 0)).toBe(250);
  });

  it('persists an attrition rate and reports it back on the gauge (issue #89)', async () => {
    const flour = await items.create({
      name: 'Flour',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 500, attritionPercent: 10 },
    });
    expect(flour.gauge?.attritionPercent).toBe(10);
    const reread = await items.getById(flour.id);
    expect(reread?.gauge?.attritionPercent).toBe(10);
  });

  it('rejects an out-of-range attrition rate at creation (issue #89)', async () => {
    await expect(
      items.create({
        name: 'Bad rate',
        trackingMode: 'CONSUMABLE_GAUGE',
        gauge: { unitOfMeasure: 'g', grossCapacity: 1000, attritionPercent: 150 },
      }),
    ).rejects.toThrow(/Attrition must be between/);
  });

  it('clears an attrition rate when explicitly set to null (issue #89)', async () => {
    const spool = await items.create({
      name: 'Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, attritionPercent: 5 },
    });
    // Omitting the field leaves it alone; an explicit null is what turns it back off.
    const untouched = await items.reconfigureGauge(spool.id, { tareWeight: 10 });
    expect(untouched.gauge?.attritionPercent).toBe(5);
    const cleared = await items.reconfigureGauge(spool.id, { attritionPercent: null });
    expect(cleared.gauge?.attritionPercent).toBeNull();
  });

  it('records the attrition breakdown beside the applied delta (issue #89)', async () => {
    const flour = await items.create({
      name: 'Strong flour',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 500, attritionPercent: 10 },
    });
    // The UI resolves the draw before calling; 100 g used at 10% costs 110 g.
    const after = await items.adjustGauge(flour.id, {
      delta: -110,
      note: 'Used 100g (+10g waste, 110g total)',
      attrition: { requested: 100, waste: 10 },
    });
    expect(after.gauge?.currentNetValue).toBe(390);

    const history = await items.getHistory(flour.id);
    expect(history.rows[0]?.netValueDelta).toBe(-110);
    expect(history.rows[0]?.metadata).toEqual({
      attrition: { requested: 100, waste: 10, total: 110, applied: 110 },
    });
    // Nothing was cut short, so the note must not claim it was.
    expect(history.rows[0]?.note).not.toContain('was available');
  });

  it('does not claim a short draw on a fractional amount that fitted (issue #89)', async () => {
    // `nextNet - currentNetValue` re-introduces float error on fractional draws; comparing
    // magnitudes there wrongly reported a short draw on roughly a third of them.
    const spool = await items.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 978.87 },
    });
    const after = await items.adjustGauge(spool.id, {
      delta: -12.5834,
      attrition: { requested: 9.83, waste: 2.7534 },
    });
    expect(after.gauge?.currentNetValue).toBeCloseTo(966.2866, 4);
    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.note).not.toContain('was available');
  });

  it('says so in the note when the gauge ran out mid-draw (issue #89)', async () => {
    const spool = await items.create({
      name: 'Nearly gone',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, currentNetValue: 50 },
    });
    const after = await items.adjustGauge(spool.id, {
      delta: -110,
      note: 'Used 100g (+10g waste, 110g total)',
      attrition: { requested: 100, waste: 10 },
    });
    expect(after.gauge?.currentNetValue).toBe(0);
    const history = await items.getHistory(spool.id);
    // The intent is preserved in metadata, but the note must not assert 110 g left a gauge
    // that only held 50 g.
    expect(history.rows[0]?.netValueDelta).toBe(-50);
    expect(history.rows[0]?.note).toContain('only 50g was available');
    expect(history.rows[0]?.metadata).toEqual({
      attrition: { requested: 100, waste: 10, total: 110, applied: 50 },
    });
  });

  it('corrects a gauge’s unit, capacity and tare in place (issue #69)', async () => {
    // A 100 m cable drum entered with the wrong unit — previously only fixable by
    // deleting the item and losing its history.
    const drum = await items.create({
      name: 'Cat6 drum',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 100, tareWeight: 0, currentNetValue: 85.5 },
    });
    const fixed = await items.reconfigureGauge(drum.id, { unitOfMeasure: 'm', tareWeight: 2 });
    expect(fixed.gauge?.unitOfMeasure).toBe('m');
    expect(fixed.gauge?.tareWeight).toBe(2);
    // A relabel moves no material — the drum still holds 85.5 m.
    expect(fixed.gauge?.currentNetValue).toBe(85.5);

    const history = await items.getHistory(drum.id);
    expect(history.rows[0]?.action).toBe('GAUGE_UPDATE');
    expect(history.rows[0]?.note).toContain('unit g → m');
    // A pure relabel is not a stock movement, so it carries no net delta.
    expect(history.rows[0]?.netValueDelta).toBeNull();
  });

  it('spills material and logs the delta when a gauge is shrunk below its level (issue #69)', async () => {
    const spool = await items.create({
      name: 'PLA',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 800 },
    });
    const smaller = await items.reconfigureGauge(spool.id, { grossCapacity: 600 });
    expect(smaller.gauge?.grossCapacity).toBe(600);
    // §4.1.1 forbids a net value above capacity, so the excess has to go somewhere.
    expect(smaller.gauge?.currentNetValue).toBe(600);

    const history = await items.getHistory(spool.id);
    expect(history.rows[0]?.netValueDelta).toBe(-200);
    expect(history.rows[0]?.note).toContain('200g over capacity discarded');
  });

  it('records nothing when a gauge reconfiguration changes nothing (issue #69)', async () => {
    const spool = await items.create({
      name: 'Resin',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250, currentNetValue: 800 },
    });
    const before = await items.getHistory(spool.id);
    await items.reconfigureGauge(spool.id, { unitOfMeasure: 'g', grossCapacity: 1000, tareWeight: 250 });
    const after = await items.getHistory(spool.id);
    expect(after.rows.length).toBe(before.rows.length);
  });

  it('rejects an invalid gauge configuration rather than surfacing a raw constraint (issue #69)', async () => {
    const spool = await items.create({
      name: 'Filament',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    await expect(items.reconfigureGauge(spool.id, { grossCapacity: 0 })).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
    await expect(items.reconfigureGauge(spool.id, { tareWeight: -1 })).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
    await expect(items.reconfigureGauge(spool.id, { unitOfMeasure: '  ' })).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('rejects gauge reconfiguration on a non-gauge item (issue #69)', async () => {
    const screws = await items.create({ name: 'Screws', trackingMode: 'DISCRETE', quantity: 10 });
    await expect(items.reconfigureGauge(screws.id, { unitOfMeasure: 'g' })).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('rejects quantity adjustment on a gauge item', async () => {
    const spool = await items.create({
      name: 'Spool',
      trackingMode: 'CONSUMABLE_GAUGE',
      gauge: { unitOfMeasure: 'g', grossCapacity: 1000 },
    });
    await expect(items.adjustQuantity(spool.id, 5)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT',
    });
  });

  it('soft-deletes (preserving history) and restores', async () => {
    const item = await items.create({ name: 'Multimeter', trackingMode: 'SERIALISED' });
    const removed = await items.softDelete(item.id);
    expect(removed.isActive).toBe(false);

    const restored = await items.restore(item.id);
    expect(restored.isActive).toBe(true);

    const history = await items.getHistory(item.id);
    const actions = history.rows.map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['SOFT_DELETED', 'RESTORED', 'CREATED']));
  });

  it('hard-deletes and cascades the activity log', async () => {
    const item = await items.create({ name: 'Doomed' });
    await items.hardDelete(item.id);
    expect(await items.getById(item.id)).toBeUndefined();
    const history = await items.getHistory(item.id);
    expect(history.rows).toHaveLength(0);
  });

  it('honours the Hard Stop on create but permits soft and hard delete', async () => {
    let locked = false;
    const gated = new ItemRepository(driver, { isWriteSuspended: () => locked });
    const item = await gated.create({ name: 'Temp' });

    locked = true;
    await expect(gated.create({ name: 'Blocked' })).rejects.toMatchObject({
      code: 'WRITE_SUSPENDED',
    });
    // Deletes must still work to free space.
    await expect(gated.softDelete(item.id)).resolves.toMatchObject({ isActive: false });
    await expect(gated.hardDelete(item.id)).resolves.toBeUndefined();
  });

  // --- Asset lifecycle round-trip (Phase 66, v24) ----------------------------

  it('creates an item with all four asset-lifecycle fields and reads them back', async () => {
    const created = await items.create({
      name: 'Laser cutter',
      trackingMode: 'SERIALISED',
      acquiredAt: '2024-06-15',
      warrantyExpiresAt: '2027-06-15',
      purchasePrice: 1499.99,
      depreciationMonths: 60,
    });
    expect(created.acquiredAt).toBe('2024-06-15');
    expect(created.warrantyExpiresAt).toBe('2027-06-15');
    expect(created.purchasePrice).toBeCloseTo(1499.99);
    expect(created.depreciationMonths).toBe(60);

    // Verify via a fresh DB read, not just the returned object.
    const reread = await items.getById(created.id);
    expect(reread?.acquiredAt).toBe('2024-06-15');
    expect(reread?.warrantyExpiresAt).toBe('2027-06-15');
    expect(reread?.purchasePrice).toBeCloseTo(1499.99);
    expect(reread?.depreciationMonths).toBe(60);
  });

  it('creates an item without asset fields — all default to null (additive, no regression)', async () => {
    const created = await items.create({ name: 'Generic widget' });
    expect(created.acquiredAt).toBeNull();
    expect(created.warrantyExpiresAt).toBeNull();
    expect(created.purchasePrice).toBeNull();
    expect(created.depreciationMonths).toBeNull();
  });

  it('updates the four asset-lifecycle fields and confirms they are persisted', async () => {
    const item = await items.create({ name: 'Oscilloscope' });
    expect(item.purchasePrice).toBeNull();

    const updated = await items.update(item.id, {
      acquiredAt: '2023-03-01',
      warrantyExpiresAt: '2025-03-01',
      purchasePrice: 899,
      depreciationMonths: 48,
    });
    expect(updated.acquiredAt).toBe('2023-03-01');
    expect(updated.warrantyExpiresAt).toBe('2025-03-01');
    expect(updated.purchasePrice).toBe(899);
    expect(updated.depreciationMonths).toBe(48);

    // Confirm persistence via another read.
    const reread = await items.getById(item.id);
    expect(reread?.purchasePrice).toBe(899);
    expect(reread?.depreciationMonths).toBe(48);
  });

  it('clears asset-lifecycle fields back to null by passing null', async () => {
    const item = await items.create({
      name: 'Multimeter',
      acquiredAt: '2022-01-01',
      purchasePrice: 50,
    });
    const cleared = await items.update(item.id, { acquiredAt: null, purchasePrice: null });
    expect(cleared.acquiredAt).toBeNull();
    expect(cleared.purchasePrice).toBeNull();
  });

  it('round-trips the intrinsic weight (canonical grams) through create, update and clear', async () => {
    const created = await items.create({ name: 'Cordless drill', weight: 1600 });
    expect(created.weight).toBe(1600);
    // Absent on a plain item — additive, so no regression.
    const plain = await items.create({ name: 'Featherweight' });
    expect(plain.weight).toBeNull();

    const updated = await items.update(created.id, { weight: 1725 });
    expect(updated.weight).toBe(1725);
    expect((await items.getById(created.id))?.weight).toBe(1725);

    const cleared = await items.update(created.id, { weight: null });
    expect(cleared.weight).toBeNull();
  });

  it('rejects a negative weight (mirrors the DB CHECK)', async () => {
    await expect(items.create({ name: 'Antimatter', weight: -1 })).rejects.toThrow(/non-negative/i);
  });

  it('round-trips the intrinsic dimensions (canonical mm) through create, update and clear', async () => {
    const created = await items.create({ name: 'Storage box', width: 400, height: 300, depth: 250 });
    expect([created.width, created.height, created.depth]).toEqual([400, 300, 250]);
    // Absent on a plain item — additive, so no regression.
    const plain = await items.create({ name: 'Dimensionless' });
    expect([plain.width, plain.height, plain.depth]).toEqual([null, null, null]);

    const updated = await items.update(created.id, { width: 420, depth: null });
    expect([updated.width, updated.height, updated.depth]).toEqual([420, 300, null]);
    const reread = await items.getById(created.id);
    expect([reread?.width, reread?.height, reread?.depth]).toEqual([420, 300, null]);
  });

  it('rejects a negative dimension (mirrors the DB CHECK)', async () => {
    await expect(items.create({ name: 'Impossible', height: -1 })).rejects.toThrow(/non-negative/i);
  });
});
