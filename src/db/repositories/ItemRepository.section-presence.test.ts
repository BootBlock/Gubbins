/**
 * `getSectionPresence` — the probe that keeps category-scoped hiding honest (issue #618).
 *
 * A category can hide the capabilities its items don't have, but hiding must never make
 * *existing* data invisible, so a hidden section is shown anyway when it holds something.
 * That promise is only as good as this query: a false negative here silently swallows real
 * data, which is precisely the failure the "show it with a note" rule exists to prevent.
 *
 * Each case therefore pins one section independently — that writing to one table lights up
 * its own flag and *only* its own flag — plus the two cases most likely to be got wrong: the
 * anonymous remainder batch must not read as a tracked batch, and a custom field showing a
 * category default (rather than a stored value) must not read as stored data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, NO_SECTION_PRESENCE } from './ItemRepository';
import { CategoryRepository } from './CategoryRepository';
import { LocationRepository } from './LocationRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { TagRepository } from './TagRepository';
import { ProjectRepository } from './ProjectRepository';

describe('ItemRepository.getSectionPresence', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let locations: LocationRepository;
  let maintenance: MaintenanceRepository;
  let tags: TagRepository;
  let projects: ProjectRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    locations = new LocationRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    tags = new TagRepository(driver);
    projects = new ProjectRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  const newItem = async (name = 'Widget') => (await items.create({ name })).id;

  it('reports nothing for a bare item', async () => {
    expect(await items.getSectionPresence(await newItem())).toEqual(NO_SECTION_PRESENCE);
  });

  it('reports nothing for an id that does not exist, rather than throwing', async () => {
    // The dialog probes off the item it is showing, but a stale id must degrade to "no data"
    // — which hides the section — not to an error that takes the whole dialog down.
    expect(await items.getSectionPresence('does-not-exist')).toEqual(NO_SECTION_PRESENCE);
  });

  it('lights up maintenance, and only maintenance, for a schedule', async () => {
    const id = await newItem();
    await maintenance.create({ itemId: id, name: 'Service', basis: 'TIME', intervalDays: 30 });
    expect(await items.getSectionPresence(id)).toEqual({ ...NO_SECTION_PRESENCE, maintenance: true });
  });

  it('lights up tags, and only tags, for a tag', async () => {
    const id = await newItem();
    await tags.setForItem(id, ['sharp']);
    expect(await items.getSectionPresence(id)).toEqual({ ...NO_SECTION_PRESENCE, tags: true });
  });

  it('lights up capabilities, and only capabilities, for a capability', async () => {
    const id = await newItem();
    await items.setCapability(id, { key: 'voltage', value: '3.3' });
    expect(await items.getSectionPresence(id)).toEqual({ ...NO_SECTION_PRESENCE, capabilities: true });
  });

  it('lights up customFields only once a value is actually stored', async () => {
    const category = await categories.create({ name: 'Tools' });
    await categories.addField(category.id, { name: 'Maker', fieldType: 'TEXT', defaultValue: 'Acme' });
    const id = (await items.create({ name: 'Drill', categoryId: category.id })).id;

    // The field resolves to the category default, but the item stores nothing of its own —
    // showing a section for a value the user never entered would be noise, not rescued data.
    expect((await items.getSectionPresence(id)).customFields).toBe(false);

    const [field] = await categories.listFields(category.id);
    await categories.setItemFieldValues(id, { [field.id]: 'Makita' });
    expect((await items.getSectionPresence(id)).customFields).toBe(true);
  });

  it('does not count the anonymous remainder batch as a tracked batch', async () => {
    const location = await locations.create({ name: 'Shelf' });
    const id = (await items.create({ name: 'Resin', locationId: location.id, quantity: 5 })).id;

    // Plain stock carries no batch identity, so it lands in the anonymous remainder batch.
    // The stock breakdown treats that as "nothing to show", and so must this — otherwise
    // every item with stock would count as holding batch data and never hide.
    expect((await items.getSectionPresence(id)).batches).toBe(false);

    // An identified lot arrives by receiving it, which is what gives the batch a real key.
    const project = await projects.create({ name: 'P' });
    const line = await projects.addLine(project.id, { itemId: id, requiredQty: 4 });
    await projects.setProcurement(line.id, 'IN_TRANSIT');
    await projects.receiveLine(line.id, {
      locationId: location.id,
      quantity: 4,
      batch: { batchNumber: 'B-42', lotNumber: null, expiryDate: null },
    });
    expect((await items.getSectionPresence(id)).batches).toBe(true);
  });

  it('keeps sections independent when several hold data at once', async () => {
    const id = await newItem();
    await maintenance.create({ itemId: id, name: 'Service', basis: 'TIME', intervalDays: 30 });
    await tags.setForItem(id, ['sharp']);
    expect(await items.getSectionPresence(id)).toEqual({
      ...NO_SECTION_PRESENCE,
      maintenance: true,
      tags: true,
    });
  });
});
