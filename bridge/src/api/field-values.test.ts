/**
 * Custom-field values over the read API (task A1) — the read-only projection of the app's
 * field dictionary onto items and locations.
 *
 * Three guarantees are tested here, all over the SYNTHETIC fixture:
 *   1. the projected **shape** is what the DTO promises;
 *   2. an item that **inherits** a value from its location reads exactly what the app's own
 *      resolver returns (the bridge never forks the inheritance rule); and
 *   3. the values are **absent by default** and appear only when the caller asks for them.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridgeServer, type BridgeServerState } from '../server.ts';
import { findTool } from '../mcp/tools.ts';
import { CategoryRepository, INHERIT_VALUE } from '@/db/repositories/CategoryRepository.ts';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { loadItemDetail } from '../item-detail.ts';
import { toItemFieldValues } from './dto.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
} from './item-view.ts';
import {
  createLocationViewContext,
  parseLocationSelection,
  projectLocation,
  LOCATION_DEFAULT_FIELDS,
} from './location-view.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

/** The item under test and the location it lives in, both from the synthetic fixture. */
const ITEM_ID = 'item-esp32';
const CATEGORY_ID = 'cat-electronics';
const LOCATION_ID = 'loc-shelf-2';

let TOKEN = '';
let hydrated: HydrateResult;

/**
 * Give the fixture two custom fields: one the location offers to everything beneath it (the
 * "which light is above this shelf" case the automation scenario needs), and one the item
 * sets for itself.
 */
async function seedFields(): Promise<void> {
  const categories = new CategoryRepository(hydrated.driver);
  const indicator = await categories.addField(CATEGORY_ID, {
    name: 'Indicator Entity',
    fieldType: 'TEXT',
  });
  const datasheet = await categories.addField(CATEGORY_ID, { name: 'Datasheet', fieldType: 'TEXT' });

  // The location offers its value to the items stored beneath it…
  await categories.setLocationFieldValue(LOCATION_ID, {
    defId: indicator.defId,
    value: 'light.shelf_two',
    isInheritable: true,
  });
  // …and the item opts in to that offer, while setting the other field itself.
  await categories.setItemFieldValues(ITEM_ID, {
    [indicator.id]: INHERIT_VALUE,
    [datasheet.id]: 'https://example.com/esp32.pdf',
  });
}

beforeEach(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  // A caller is identified by a per-user token now, so the test mints one for the built-in
  // Admin (unrestricted, like the old shared token) against the hydrated fixture.
  TOKEN = await mintTestToken(hydrated.driver);
  await seedFields();
});

afterEach(async () => {
  await hydrated.driver.close();
});

describe('item custom-field values', () => {
  it('projects the documented shape, resolving location inheritance', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById(ITEM_ID);
    const selection = parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, { include: 'fields' });
    const projected = await projectItem(createItemViewContext(driver, item!), selection);

    // Ordered as the app orders a category's fields (position, then name).
    expect(projected.fieldValues).toEqual([
      {
        name: 'Datasheet',
        fieldType: 'TEXT',
        value: 'https://example.com/esp32.pdf',
        source: 'stored',
        inheritedFrom: null,
      },
      {
        name: 'Indicator Entity',
        fieldType: 'TEXT',
        value: 'light.shelf_two',
        source: 'inherited',
        inheritedFrom: { locationId: LOCATION_ID, locationName: 'Shelf 2' },
      },
    ]);
  });

  it('resolves exactly what the app resolves (no forked inheritance rule)', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById(ITEM_ID);
    const projected = await projectItem(
      createItemViewContext(driver, item!),
      parseItemSelection([], { fields: 'fieldValues' }),
    );
    // The app's own resolver, projected through the same mapper, must agree value-for-value.
    const app = toItemFieldValues(await new CategoryRepository(driver).resolveItemFields(ITEM_ID));
    expect(projected.fieldValues).toEqual(app);
  });

  it('omits fields the item has no value for', async () => {
    const driver = hydrated.driver;
    // A fixture item in the other category has no custom fields at all.
    const bolt = await new ItemRepository(driver).getById('item-m3-bolt');
    const projected = await projectItem(
      createItemViewContext(driver, bolt!),
      parseItemSelection([], { fields: 'fieldValues' }),
    );
    expect(projected.fieldValues).toEqual([]);
  });

  it('is absent from the default payload and never read for it', async () => {
    const driver = hydrated.driver;
    const item = await new ItemRepository(driver).getById(ITEM_ID);
    const ctx = createItemViewContext(driver, item!);
    const spy = vi.spyOn(ctx, 'fieldValues');

    const defaults = await projectItem(ctx, parseItemSelection(ITEM_DETAIL_DEFAULT_FIELDS, {}));
    expect(defaults).not.toHaveProperty('fieldValues');
    expect(spy).not.toHaveBeenCalled();

    // …and the canonical detail loader is unchanged too, so the DTO stays additive-only.
    expect(await loadItemDetail(driver, ITEM_ID)).not.toHaveProperty('fieldValues');
  });
});

describe('location custom-field values', () => {
  it('projects the location values it holds, with the inheritability flag', async () => {
    const driver = hydrated.driver;
    const location = await new LocationRepository(driver).getById(LOCATION_ID);
    const projected = await projectLocation(
      createLocationViewContext(driver, { ...location!, itemCount: 1 }),
      parseLocationSelection({ include: 'fields' }),
    );

    expect(projected.fieldValues).toEqual([
      {
        name: 'Indicator Entity',
        fieldType: 'TEXT',
        value: 'light.shelf_two',
        isInheritable: true,
      },
    ]);
    // The default fields are still all there — `include` adds, it does not replace.
    for (const name of LOCATION_DEFAULT_FIELDS) expect(projected).toHaveProperty(name);
  });

  it('is absent from the default payload and never read for it', async () => {
    const driver = hydrated.driver;
    const location = await new LocationRepository(driver).getById(LOCATION_ID);
    const ctx = createLocationViewContext(driver, { ...location!, itemCount: 1 });
    const spy = vi.spyOn(ctx, 'fieldValues');

    const projected = await projectLocation(ctx, parseLocationSelection({}));
    expect(projected).not.toHaveProperty('fieldValues');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('MCP tools see the same shape', () => {
  it('gubbins_get_item and gubbins_list_locations honour include=fields', async () => {
    const driver = hydrated.driver;
    const item = (await findTool('gubbins_get_item')!.run(driver, {
      id: ITEM_ID,
      include: 'fields',
    })) as { item: Record<string, unknown> };
    expect(item.item.fieldValues).toContainEqual(
      expect.objectContaining({ name: 'Indicator Entity', source: 'inherited' }),
    );

    const locations = findTool('gubbins_list_locations')!;
    const withFields = (await locations.run(driver, { include: 'fields' })) as {
      data: { id: string; fieldValues?: unknown }[];
    };
    expect(withFields.data.find((row) => row.id === LOCATION_ID)?.fieldValues).toEqual([
      { name: 'Indicator Entity', fieldType: 'TEXT', value: 'light.shelf_two', isInheritable: true },
    ]);

    // Absent by default, exactly as over HTTP.
    const plain = (await locations.run(driver, {})) as { data: Record<string, unknown>[] };
    for (const row of plain.data) expect(row).not.toHaveProperty('fieldValues');
  });
});

describe('over HTTP', () => {
  let server: ReturnType<typeof createBridgeServer>;
  let baseUrl: string;

  beforeEach(async () => {
    const state: BridgeServerState = {
      driver: hydrated.driver,
      snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
    };
    server = createBridgeServer({ getState: () => state });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const json = async (path: string): Promise<any> =>
    (await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();

  it('adds fieldValues to items and locations only when asked', async () => {
    expect(await json(`/api/v1/items/${ITEM_ID}`)).not.toHaveProperty('fieldValues');
    expect(await json(`/api/v1/locations/${LOCATION_ID}`)).not.toHaveProperty('fieldValues');

    const item = await json(`/api/v1/items/${ITEM_ID}?include=fields`);
    expect(item.fieldValues).toContainEqual(
      expect.objectContaining({ name: 'Indicator Entity', value: 'light.shelf_two' }),
    );
    // …and the rest of the default payload is still there — `include` adds, never replaces.
    expect(item.name).toBe('ESP32 Dev Board');

    const location = await json(`/api/v1/locations/${LOCATION_ID}?include=fields`);
    expect(location.fieldValues).toEqual([
      { name: 'Indicator Entity', fieldType: 'TEXT', value: 'light.shelf_two', isInheritable: true },
    ]);

    // The list endpoint honours it too (this is what a bulk integration reads).
    const list = await json('/api/v1/locations?include=fields');
    const shelf = (list.data as { id: string }[]).find((row) => row.id === LOCATION_ID);
    expect(shelf).toHaveProperty('fieldValues');
  });

  it('rejects an unknown location field with a 400', async () => {
    const body = await json('/api/v1/locations?include=nonsuch');
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('nonsuch');
  });
});
