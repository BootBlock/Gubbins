import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TarePresetRepository, TombstoneRepository } from './index';

/**
 * TarePresetRepository (issue #94). Exercises the thin SQL glue around the pure `tare-presets`
 * seam: create/update funnel through `planTarePreset` (validating the name and weight, softening
 * an unknown kind), the list order is the stable name → oldest → id total order, and a delete
 * records a tombstone so the removal syncs (but a delete of a missing id records none).
 */
describe('TarePresetRepository (issue #94)', () => {
  let driver: MemoryDriver;
  let presets: TarePresetRepository;
  let tombstones: TombstoneRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    presets = new TarePresetRepository(driver);
    tombstones = new TombstoneRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('creates an entry, normalising through the seam', async () => {
    const preset = await presets.create({
      name: '  Flour jar ',
      brand: '  ',
      kind: 'JAR',
      tareGrams: 412,
      note: '  weighed empty ',
    });
    expect(preset).toMatchObject({
      name: 'Flour jar',
      brand: null,
      kind: 'JAR',
      tareGrams: 412,
      note: 'weighed empty',
    });
  });

  it('softens an unknown kind to OTHER rather than failing', async () => {
    const preset = await presets.create({ name: 'Mystery tub', kind: 'CRATE', tareGrams: 90 });
    expect(preset.kind).toBe('OTHER');
  });

  /** A container that weighs nothing measurable is odd but legal; a negative one is not. */
  it('accepts a zero weight but rejects a negative one', async () => {
    await expect(presets.create({ name: 'Weightless', tareGrams: 0 })).resolves.toMatchObject({
      tareGrams: 0,
    });
    await expect(presets.create({ name: 'Impossible', tareGrams: -1 })).rejects.toThrow(/non-negative/i);
  });

  it('rejects a blank name', async () => {
    await expect(presets.create({ name: '   ', tareGrams: 100 })).rejects.toThrow(/must have a name/i);
  });

  it('lists by name, case-insensitively', async () => {
    await presets.create({ name: 'zinc bin', tareGrams: 300 });
    await presets.create({ name: 'Acrylic tray', tareGrams: 40 });
    await presets.create({ name: 'mason jar', tareGrams: 260 });
    const page = await presets.list();
    expect(page.rows.map((p) => p.name)).toEqual(['Acrylic tray', 'mason jar', 'zinc bin']);
  });

  it('updates only the provided fields', async () => {
    const created = await presets.create({ name: 'Jar', kind: 'JAR', tareGrams: 260, note: 'old' });
    const updated = await presets.update(created.id, { tareGrams: 268 });
    expect(updated).toMatchObject({ name: 'Jar', kind: 'JAR', tareGrams: 268, note: 'old' });
  });

  it('clears an optional field when passed null', async () => {
    const created = await presets.create({ name: 'Jar', tareGrams: 260, note: 'old' });
    expect((await presets.update(created.id, { note: null })).note).toBeNull();
  });

  it('refuses to clear the name to blank', async () => {
    const created = await presets.create({ name: 'Jar', tareGrams: 260 });
    await expect(presets.update(created.id, { name: '  ' })).rejects.toThrow(/must have a name/i);
  });

  it('records a tombstone on delete so the removal syncs', async () => {
    const created = await presets.create({ name: 'Jar', tareGrams: 260 });
    await presets.delete(created.id);
    expect(await presets.getById(created.id)).toBeUndefined();
    const recorded = await tombstones.list();
    expect(recorded.rows.some((t) => t.tableName === 'tare_presets' && t.id === created.id)).toBe(true);
  });

  /**
   * Tombstoning an id this device never held would wrongly instruct every peer to delete a row
   * they may legitimately have.
   */
  it('records no tombstone when deleting an id that was never here', async () => {
    await presets.delete('never-existed');
    expect((await tombstones.list()).rows).toEqual([]);
  });
});
