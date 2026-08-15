/**
 * Every natural key the sync merge folds must have a write path that folds the same way
 * (issue #679).
 *
 * `features/sync/unique-keys.ts` decides "are these two rows the same name?" through
 * `lib/name-fold`, which folds the whole of Unicode. The `UNIQUE (… COLLATE NOCASE)` indexes
 * those keys live under fold ASCII A–Z and nothing else. Where a write path agrees with the
 * *index* rather than the *fold*, the app stores two rows the merge believes are one, and the
 * merge it then plans trips the very constraint it exists to route around — aborting the whole
 * atomic merge, which never advances the watermark, so sync stays stuck on that plan forever.
 *
 * This file holds the two definitions in step, in two layers:
 *
 * 1. A **drift check**: the folded columns declared by `UNIQUE_KEY_SPECS` must be exactly the
 *    ones exercised below. Adding a NOCASE spec to the resolver without converting its writer
 *    fails here rather than in a user's stuck sync.
 * 2. A **behavioural check** per column, against the real baseline schema: filing two spellings
 *    that fold to one key must leave one row, whether the second is folded onto the first or
 *    refused outright.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { foldName } from '@/lib/name-fold';
import { FOLDED_UNIQUE_COLUMNS } from '@/features/sync/unique-keys';
import { CategoryRepository } from './CategoryRepository';
import { ContactRepository } from './ContactRepository';
import { ItemRepository } from './ItemRepository';
import { RoleRepository } from './RoleRepository';
import { TagRepository } from './TagRepository';
import { UserRepository } from './UserRepository';

/** The repositories and rows a write-path exercise needs to reach its table. */
interface Fixture {
  readonly driver: MemoryDriver;
  readonly categories: CategoryRepository;
  readonly contacts: ContactRepository;
  readonly items: ItemRepository;
  readonly roles: RoleRepository;
  readonly tags: TagRepository;
  readonly users: UserRepository;
  /** Two items, so a per-item key can be exercised on one and a table-wide key across both. */
  readonly itemIds: readonly [string, string];
}

/**
 * File `name` through the write path that owns a column, on the `nth` (0 or 1) attempt.
 *
 * `nth` exists because the two attempts must genuinely compete. A table-wide key
 * (`item_aliases.alias`) filed twice against the *same* item would replace itself and pass
 * whatever the fold did; a per-item key (`capabilities.key`) filed against two different items
 * would never compete at all.
 */
type FileName = (fixture: Fixture, name: string, nth: 0 | 1) => Promise<unknown>;

const WRITE_PATHS: Record<string, FileName> = {
  'field_defs.name': (f, name, nth) => f.categories.addField(`cat-${nth}`, { name, fieldType: 'TEXT' }),
  'tags.name': (f, name, nth) => f.tags.setForItem(f.itemIds[nth], [name]),
  'roles.name': (f, name) => f.roles.create({ name }),
  'users.username': (f, name) => f.users.create({ username: name }),
  'contacts.name': (f, name) => f.contacts.resolveOrCreate(name),
  'capabilities.key': (f, key) => f.items.setCapability(f.itemIds[0], { key, value: '1' }),
  'item_aliases.alias': (f, alias, nth) => f.items.setAliases(f.itemIds[nth], [alias]),
};

/**
 * Pairs that the index cannot tell apart from two distinct names, but a user cannot tell apart
 * at all. `ß` needs the upper-case leg of the fold (`'Größe'.toLowerCase()` leaves it alone), so
 * it exercises more of `foldName` than an accent does.
 */
const SPELLINGS: readonly [string, string] = ['Größe', 'GRÖSSE'];

describe('folded natural keys (issue #679)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('PRAGMA foreign_keys = ON;');

    const categories = new CategoryRepository(driver);
    const items = new ItemRepository(driver);
    // Two categories, so the dictionary is reached twice over — reuse by name is the whole
    // point of `field_defs`, and adding one field twice to one category is refused by
    // `UNIQUE (category_id, def_id)` for an unrelated reason.
    for (const nth of [0, 1]) {
      await driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', [
        `cat-${nth}`,
        `Category ${nth}`,
      ]);
    }
    const first = await items.create({ name: 'First' });
    const second = await items.create({ name: 'Second' });

    fixture = {
      driver,
      categories,
      contacts: new ContactRepository(driver),
      items,
      roles: new RoleRepository(driver),
      tags: new TagRepository(driver),
      users: new UserRepository(driver),
      itemIds: [first.id, second.id],
    };
  });

  afterEach(async () => {
    await fixture.driver.close();
  });

  it('exercises exactly the columns the merge folds', () => {
    expect(Object.keys(WRITE_PATHS).sort()).toEqual([...FOLDED_UNIQUE_COLUMNS].sort());
  });

  for (const [qualified, file] of Object.entries(WRITE_PATHS)) {
    const [table, column] = qualified.split('.') as [string, string];

    it(`${qualified} files two spellings of one name as one row`, async () => {
      const [first, second] = SPELLINGS;
      await file(fixture, first, 0);

      // Either outcome is a fix: the second spelling folds onto the first, or the write path
      // refuses it the way the index refuses a spelling it *can* fold. What must not happen is
      // a second row landing quietly.
      try {
        await file(fixture, second, 1);
      } catch (error) {
        expect(error).toBeInstanceOf(DbError);
      }

      const rows = await fixture.driver.query<Record<string, string>>(
        `SELECT ${column} AS value FROM ${table};`,
      );
      const key = foldName(first);
      expect(rows.filter((row) => foldName(row.value ?? '') === key)).toHaveLength(1);
    });
  }
});
