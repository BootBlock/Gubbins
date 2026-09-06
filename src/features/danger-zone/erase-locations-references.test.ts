/**
 * "Empty custom locations" must agree with the schema about what makes a location empty
 * (issue #874).
 *
 * The target decides which locations go with one predicate, and that predicate is a claim about
 * every foreign key pointing at `locations`: each reference either makes the location non-empty,
 * or is a row that belongs to the location and dies with it. Nothing in the type system holds the
 * two together, so the claim drifted. `checkouts` reaches `locations` through two columns, and the
 * predicate tested only `source_location_id` (where units were lent *from*). A location that units
 * were lent *to* read as empty, and deleting it cascaded the open loan away, leaving the item's
 * on-hand count short with no ledger entry to explain it.
 *
 * This file is the drift test that claim asks for. It reads the references out of the real
 * migrated schema, requires every one of them to be classified below, and then *drives* each
 * classification through a real erase rather than reading the predicate's source text: a blocking
 * reference must leave its location standing, and a cascading one must not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import { CheckoutRepository } from '@/db/repositories/CheckoutRepository';
import { ItemRepository } from '@/db/repositories/ItemRepository';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';
import { eraseTargets, type ErasePorts } from './erase-actions';
import { eraseTargetById } from './erase-targets';

/** The custom location every case builds around. */
const VAN = 'loc-van';

/**
 * What a reference to `locations` means for emptiness.
 *
 * - `blocks` — the row is stock, or a promise about stock, that the location is party to. A
 *   location carrying one is not empty, and the erase must leave it alone.
 * - `cascades` — the row is an attribute *of* the location: its own photo, tag or field value. It
 *   is destroyed with the location and tombstoned by the target, so it does not stand in the way.
 * - `hierarchy` — the location tree's own shape. What the erase does with a parent whose children
 *   survive is a separate question, tracked by issue #873, and is not this claim.
 */
type Classification = 'blocks' | 'cascades' | 'hierarchy';

interface ReferenceCase {
  /** How the target must treat a location carrying this reference. */
  readonly kind: Classification;
  /** Create exactly one row that points at {@link VAN} through this column. */
  readonly seed?: (driver: MemoryDriver, itemId: string) => Promise<void>;
}

/**
 * Every `<table>.<column>` that references `locations`, and what it means. A reference the schema
 * grows and nobody classifies fails the first test below, rather than being silently counted as
 * "empty" the way `checkouts.location_id` was.
 */
const REFERENCES: Readonly<Record<string, ReferenceCase>> = {
  'checkouts.location_id': {
    kind: 'blocks',
    // The loan *target* — the units are out at the van. Made through the real check-out path, so
    // the stock movement and the ledger entry are the ones a user's loan actually produces.
    seed: async (driver, itemId) => {
      await new CheckoutRepository(driver).checkout({ itemId, locationId: VAN, quantity: 2 });
    },
  },
  'checkouts.source_location_id': {
    kind: 'blocks',
    // The provenance — the shelf the units were lent from, and where a return puts them back.
    seed: async (driver, itemId) => {
      const checkout = await new CheckoutRepository(driver).checkout({
        itemId,
        contactName: 'Ada Lovelace',
        quantity: 1,
      });
      await driver.execute('UPDATE checkouts SET source_location_id = ? WHERE id = ?;', [VAN, checkout.id]);
    },
  },
  'items.location_id': {
    kind: 'blocks',
    seed: async (driver) => {
      await new ItemRepository(driver).create({ name: 'Torque wrench', locationId: VAN });
    },
  },
  'item_stock.location_id': {
    kind: 'blocks',
    seed: async (driver, itemId) => {
      await driver.execute(
        'INSERT INTO item_stock (id, item_id, location_id, quantity) VALUES (?, ?, ?, 0);',
        [itemId + '|' + VAN, itemId, VAN],
      );
    },
  },
  'stock_batches.location_id': {
    kind: 'blocks',
    seed: async (driver, itemId) => {
      await driver.execute(
        `INSERT INTO stock_batches (id, item_id, location_id, batch_key, lot_number, quantity)
         VALUES (?, ?, ?, 'lot-7', 'lot-7', 0);`,
        [itemId + '|' + VAN + '|lot-7', itemId, VAN],
      );
    },
  },
  'maintenance_schedules.location_id': {
    kind: 'blocks',
    seed: async (driver, itemId) => {
      await driver.execute(
        `INSERT INTO maintenance_schedules (id, item_id, name, basis, interval_days, location_id)
         VALUES ('sched-1', ?, 'Grease the bearings', 'TIME', 30, ?);`,
        [itemId, VAN],
      );
    },
  },
  'location_photos.location_id': {
    kind: 'cascades',
    seed: async (driver) => {
      await driver.execute(
        `INSERT INTO location_photos (id, location_id, full_res_opfs_path, natural_width, natural_height)
         VALUES ('photo-1', ?, 'images/van.webp', 800, 600);`,
        [VAN],
      );
    },
  },
  'location_tags.location_id': {
    kind: 'cascades',
    seed: async (driver) => {
      await driver.execute(`INSERT INTO tags (id, name) VALUES ('tag-1', 'Mobile');`);
      await driver.execute('INSERT INTO location_tags (location_id, tag_id) VALUES (?, ?);', [VAN, 'tag-1']);
    },
  },
  'location_field_values.location_id': {
    kind: 'cascades',
    seed: async (driver) => {
      await driver.execute(
        `INSERT INTO field_defs (id, name, field_type) VALUES ('def-1', 'Registration', 'TEXT');`,
      );
      await driver.execute(
        `INSERT INTO location_field_values (id, location_id, def_id, value)
         VALUES ('lfv-1', ?, 'def-1', 'AB12 CDE');`,
        [VAN],
      );
    },
  },
  // The self-reference. Left undriven on purpose — see `hierarchy` above.
  'locations.parent_id': { kind: 'hierarchy' },
};

/** A minimal Storage stand-in; none of the database targets touch it. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

describe('"Empty custom locations" and the references the schema declares', () => {
  let driver: MemoryDriver;
  let itemId: string;

  /** One empty custom location, and one item homed at Unassigned for the seeds to draw on. */
  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute('INSERT INTO locations (id, name, is_system) VALUES (?, ?, 0);', [VAN, 'The van']);
    const item = await new ItemRepository(driver).create({
      name: 'Impact driver',
      quantity: 5,
      locationId: UNASSIGNED_LOCATION_ID,
    });
    itemId = item.id;
  });

  afterEach(async () => {
    await driver.close();
  });

  function ports(): ErasePorts {
    return {
      db: driver,
      deleteImageFiles: vi.fn(async () => {}),
      deleteIdb: vi.fn(async () => {}),
      local: fakeStorage(),
      authority: () => UNRESTRICTED_AUTHORITY,
    };
  }

  /** How many locations the badge offers to erase, read through the target's own count. */
  async function badgeCount(): Promise<number> {
    const row = await driver.queryOne<{ n: number }>(eraseTargetById('locations')!.countSql!);
    return Number(row?.n ?? 0);
  }

  /** Run the `locations` erase and report how many rows named {@link VAN} survived it. */
  async function eraseAndCountVan(): Promise<number> {
    await eraseTargets(['locations'], { tombstone: true }, ports());
    const row = await driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM locations WHERE id = ?;', [
      VAN,
    ]);
    return Number(row?.n ?? 0);
  }

  it('classifies every reference the migrated schema declares', async () => {
    const rows = await driver.query<{ tbl: string; col: string }>(
      `SELECT m.name AS tbl, f."from" AS col
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'locations'
        ORDER BY tbl, col;`,
    );

    expect(rows.map((row) => `${row.tbl}.${row.col}`)).toEqual(Object.keys(REFERENCES).sort());
  });

  const blocking = Object.entries(REFERENCES).filter(([, ref]) => ref.kind === 'blocks');
  const cascading = Object.entries(REFERENCES).filter(([, ref]) => ref.kind === 'cascades');

  it.each(blocking)('keeps a location carrying %s, and never counts it', async (_ref, { seed }) => {
    await seed!(driver, itemId);

    // The count and the delete share the predicate, so a badge offering a location the delete
    // then keeps would be the same drift read from the other end.
    expect(await badgeCount()).toBe(0);
    expect(await eraseAndCountVan()).toBe(1);
  });

  it.each(cascading)('still erases a location carrying only %s', async (_ref, { seed }) => {
    await seed!(driver, itemId);

    expect(await badgeCount()).toBe(1);
    expect(await eraseAndCountVan()).toBe(0);
  });

  it('erases a location that nothing references at all', async () => {
    expect(await badgeCount()).toBe(1);
    expect(await eraseAndCountVan()).toBe(0);
  });

  it('leaves the loan and the stock alone when units are lent to a location', async () => {
    // The issue's own reproduction, end to end: 5 on hand, 2 lent to the van, then the erase.
    const items = new ItemRepository(driver);
    await new CheckoutRepository(driver).checkout({ itemId, locationId: VAN, quantity: 2 });
    expect((await items.getById(itemId))?.quantity).toBe(3);

    expect(await eraseAndCountVan()).toBe(1);
    // The two lent units are still lent, and still accounted for. Before the fix the location
    // went, the loan went with it, and the item stayed on 3 with nothing left to explain it.
    expect((await items.getById(itemId))?.quantity).toBe(3);
    const open = await driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM checkouts WHERE location_id = ? AND returned_at IS NULL;',
      [VAN],
    );
    expect(Number(open?.n ?? 0)).toBe(1);
  });
});
