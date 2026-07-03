/**
 * Item field-registry tests over the SYNTHETIC fixture. The key guarantee here is the
 * **drift guard**: projecting the detail default field set through the registry must reproduce
 * the canonical `loadItemDetail` payload exactly, so the two never fork. Also covers lazy
 * relational resolution (an unselected relation incurs no read) and the include-`all` superset.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { loadItemDetail } from '../item-detail.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
} from './item-view.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

let hydrated: HydrateResult;

beforeEach(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
});

afterEach(async () => {
  await hydrated.driver.close();
});

describe('item field registry', () => {
  it('projecting the detail defaults reproduces loadItemDetail exactly (no drift)', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById('item-esp32');
    const selection = parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, {});
    const projected = await projectItem(createItemViewContext(driver, item!), selection);
    const canonical = await loadItemDetail(driver, 'item-esp32');
    expect(projected).toEqual(canonical);
  });

  it('include=all is a strict superset of the detail defaults', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById('item-esp32');
    const ctx = createItemViewContext(driver, item!);
    const detail = await projectItem(ctx, parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, {}));
    const all = await projectItem(ctx, parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, { include: 'all' }));
    for (const key of Object.keys(detail)) expect(all).toHaveProperty(key);
    // The extended-only fields appear only in the `all` projection.
    expect(all).toHaveProperty('notes');
    expect(all).toHaveProperty('operationalMetadata');
    expect(detail).not.toHaveProperty('notes');
  });

  it('does not read placements/capabilities for a projection that omits them', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById('item-esp32');
    const ctx = createItemViewContext(driver, item!);
    const placementsSpy = vi.spyOn(ctx, 'placements');
    const capsSpy = vi.spyOn(ctx, 'capabilities');
    await projectItem(ctx, parseItemSelection([], { fields: 'name,unitCost' }));
    expect(placementsSpy).not.toHaveBeenCalled();
    expect(capsSpy).not.toHaveBeenCalled();
  });
});
