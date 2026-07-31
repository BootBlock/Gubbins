/**
 * `getSectionPresence` — the probe that keeps category-scoped hiding honest (issue #618).
 *
 * A category can hide the capabilities its items don't have, but hiding must never make
 * *existing* data invisible, so a hidden section is shown anyway when it holds something.
 * That promise is only as good as this query: a false negative here silently swallows real
 * data, which is precisely the failure the "show it with a note" rule exists to prevent.
 *
 * Each case therefore pins one section independently — that writing to one table lights up its
 * own flag and *only* its own flag — plus the two most likely to be got wrong: a custom field
 * showing a *category default* rather than a stored value must not read as data, and the kit
 * probe must answer for the assembly rather than the part, since `kit_components` names both
 * ends and a join on the wrong column looks correct from one side.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { ItemRepository, NO_SECTION_PRESENCE } from './ItemRepository';
import { CategoryRepository } from './CategoryRepository';
import { MaintenanceRepository } from './MaintenanceRepository';
import { TagRepository } from './TagRepository';
import { AttachmentRepository } from './AttachmentRepository';

describe('ItemRepository.getSectionPresence', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let maintenance: MaintenanceRepository;
  let tags: TagRepository;
  let attachments: AttachmentRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    maintenance = new MaintenanceRepository(driver);
    tags = new TagRepository(driver);
    attachments = new AttachmentRepository(driver);
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

  it('lights up kit for the assembly, not for the part it contains', async () => {
    const kit = await newItem('Repair kit');
    const part = await newItem('Spare fuse');
    await items.addKitComponent(kit, part, 1);
    expect((await items.getSectionPresence(kit)).kit).toBe(true);
    // `kit_components` names both ends, so a join on the wrong column would still look right
    // from the assembly's side. The component must NOT report itself as a kit.
    expect((await items.getSectionPresence(part)).kit).toBe(false);
  });

  it('lights up attachments, and only attachments, for a datasheet', async () => {
    const id = await newItem();
    await attachments.add({ itemId: id, kind: 'URL', value: 'https://example.com/ds.pdf' });
    expect(await items.getSectionPresence(id)).toEqual({ ...NO_SECTION_PRESENCE, attachments: true });
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
