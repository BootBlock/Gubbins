import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { DbError } from '../errors';
import { assertTextLimit } from './text-limits';
import { CategoryRepository, ItemRepository, TagRepository, UNASSIGNED_LOCATION_ID } from './index';

describe('assertTextLimit', () => {
  it('accepts a value at the limit', () => {
    expect(() => assertTextLimit('a'.repeat(500), 500, 'A name')).not.toThrow();
  });

  it('names the field, the ceiling and the actual length', () => {
    expect(() => assertTextLimit('a'.repeat(504), 500, 'An item name')).toThrow(
      'An item name can be at most 500 characters, and this one is 504.',
    );
  });

  it('throws under the constraint code, so the write reports as a refused write', () => {
    try {
      assertTextLimit('a'.repeat(501), 500, 'An item name');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe('SQLITE_CONSTRAINT');
    }
  });

  it('measures in characters, so an emoji costs one', () => {
    expect(() => assertTextLimit('🔧'.repeat(500), 500, 'A name')).not.toThrow();
    expect(() => assertTextLimit('🔧'.repeat(501), 500, 'A name')).toThrow(/501/);
  });
});

describe('text length limits, end to end (issue #346)', () => {
  let driver: MemoryDriver;
  let items: ItemRepository;
  let categories: CategoryRepository;
  let tags: TagRepository;

  const overLine = 'a'.repeat(TEXT_LIMITS.line + 1);
  const overNote = 'a'.repeat(TEXT_LIMITS.note + 1);

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');
    items = new ItemRepository(driver);
    categories = new CategoryRepository(driver);
    tags = new TagRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it('refuses an over-long item name with a sentence, not a raw constraint failure', async () => {
    await expect(items.create({ name: overLine, locationId: UNASSIGNED_LOCATION_ID })).rejects.toThrow(
      /An item name can be at most 500 characters/,
    );
  });

  it('refuses an over-long name on the update path too', async () => {
    const item = await items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    await expect(items.update(item.id, { name: overLine })).rejects.toThrow(/An item name can be at most/);
  });

  it('accepts a name exactly at the limit', async () => {
    const name = 'a'.repeat(TEXT_LIMITS.line);
    const item = await items.create({ name, locationId: UNASSIGNED_LOCATION_ID });
    expect(item.name).toBe(name);
  });

  it('holds a description to the roomier prose tier, not the one-line one', async () => {
    const description = 'a'.repeat(TEXT_LIMITS.note);
    const item = await items.create({
      name: 'Resistor',
      description,
      locationId: UNASSIGNED_LOCATION_ID,
    });
    expect(item.description).toBe(description);

    await expect(items.update(item.id, { description: overNote })).rejects.toThrow(
      /An item description can be at most 20000 characters/,
    );
  });

  it('bounds the other free-text item fields', async () => {
    const item = await items.create({ name: 'Resistor', locationId: UNASSIGNED_LOCATION_ID });
    await expect(items.update(item.id, { mpn: overLine })).rejects.toThrow(/An MPN can be at most/);
    await expect(items.update(item.id, { manufacturer: overLine })).rejects.toThrow(
      /A manufacturer can be at most/,
    );
    await expect(items.update(item.id, { serialNumber: overLine })).rejects.toThrow(
      /A serial number can be at most/,
    );
  });

  it('bounds a category name and a tag name', async () => {
    await expect(categories.create({ name: overLine })).rejects.toThrow(/A category name can be at most/);
    await expect(tags.create(overLine)).rejects.toThrow(/A tag name can be at most/);
  });

  it('backs the whole lot with a column CHECK, for a write that arrives another way', async () => {
    // A sync apply or a restored snapshot writes rows straight in, past every validator above.
    // The schema is the line that holds there — this is the gap issue #346 opened with.
    await expect(
      driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
        crypto.randomUUID(),
        overLine,
        UNASSIGNED_LOCATION_ID,
      ]),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it('leaves a value at the ceiling storable through that same back door', async () => {
    await expect(
      driver.execute('INSERT INTO items (id, name, location_id) VALUES (?, ?, ?);', [
        crypto.randomUUID(),
        'a'.repeat(TEXT_LIMITS.line),
        UNASSIGNED_LOCATION_ID,
      ]),
    ).resolves.toBeDefined();
  });

  it('counts a stored character the way the app does, not the way UTF-16 does', async () => {
    // `length()` in SQLite counts characters, which is what `textLength` counts too. A column
    // that counted code units would refuse a name of 300 emoji that every control accepted.
    const name = '🔧'.repeat(TEXT_LIMITS.line);
    const item = await items.create({ name, locationId: UNASSIGNED_LOCATION_ID });
    expect(item.name).toBe(name);
  });
});
