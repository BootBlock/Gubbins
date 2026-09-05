/**
 * Walk-order parity: what the field accepts is exactly what the database stores (issue #461).
 *
 * The Add- and Edit-location dialogs judge a typed walk order with `resolveWalkOrderInput`, and
 * show the user the ordinal it reports. That pairing is the claim this file holds up: when the
 * field reports valid, a real migrated database — through `LocationRepository`, its INTEGER
 * column and its `CHECK (walk_order IS NULL OR walk_order >= 0)` — holds exactly the number the
 * user saw.
 *
 * `LocationRepository.test.ts` drives the repository's own coercion directly (2.9 floors, -1 and
 * NaN become null). The same values appear below, but not to check that again: they are here
 * because the claim needs them put through the *field* first, which that file never does.
 * Driving both from one typed string is what caught negative zero — `-0` passed the `< 0` guard,
 * floored to `-0`, and the column read back `0`, a field promising a value the database did not
 * return.
 *
 * The claim has a ceiling, and the last two tests pin it. Above `Number.MAX_SAFE_INTEGER` the
 * field still reports valid, and what happens next depends on how far above: below 2^63 the row
 * is written and only the read back out fails, and at 2^63 and above the write itself is
 * refused. The first of those is the worse one, and neither is fixed here — see the note on
 * `WalkOrderInput.valid`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { resolveWalkOrderInput } from '@/lib/walk-order';
import { LocationRepository } from './LocationRepository';

/**
 * What a user can leave in the field: blank, ordinary, the awkward edges around zero, and the
 * largest ordinal the claim above still covers.
 */
const TYPED = [
  '',
  '   ',
  '0',
  '1',
  ' 4 ',
  '2.9',
  '-0',
  '-1',
  '-0.5',
  'abc',
  'Infinity',
  '1e3',
  '9007199254740991',
];

describe('walk order: the field agrees with what the database stores', () => {
  let driver: MemoryDriver;
  let locations: LocationRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    locations = new LocationRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it.each(TYPED)('stores "%s" as the field said it would', async (raw) => {
    const { value, valid } = resolveWalkOrderInput(raw);

    const created = await locations.create({ name: `Shelf ${TYPED.indexOf(raw)}`, walkOrder: value });

    if (valid) {
      // The field let it through, so the database must hold exactly what the user saw.
      expect(created.walkOrder).toBe(value);
    } else {
      // The field blocked it, and the write path confirms it was right to: this position would
      // have gone nowhere.
      expect(created.walkOrder).toBeNull();
    }
  });

  it('agrees on an update as well as a create', async () => {
    // The repository normalises on its update path separately from its insert path, and the
    // existing LocationRepository tests only drive that path with a plain 1 and null. These are
    // the same edges as above, put through the other binding.
    const shelf = await locations.create({ name: 'Bench', walkOrder: 3 });

    for (const raw of TYPED) {
      const { value, valid } = resolveWalkOrderInput(raw);
      // Place the row on the route first, so every case is a real transition rather than a
      // repeat of whatever the previous iteration left behind. 7 is not a value TYPED produces.
      await locations.update(shelf.id, { walkOrder: 7 });
      const updated = await locations.update(shelf.id, { walkOrder: value });
      expect(updated.walkOrder).toBe(valid ? value : null);
    }
  });

  /** The stored ordinal of every row with this name, read as text so no int64 is converted. */
  const storedOrdinals = async (name: string) =>
    driver.query<{ ordinal: string | null }>(
      'SELECT CAST(walk_order AS TEXT) AS ordinal FROM locations WHERE name = ?;',
      [name],
    );

  it('writes a row it then cannot read back, one past the safe range', async () => {
    // The near half of the ceiling, and the half that costs something. SQLite holds the integer
    // happily, but the driver cannot hand it back as a JavaScript number — and `create` returns
    // by reading the row it just committed. So the caller is told the create failed while the
    // location sits in the table.
    const { value, valid } = resolveWalkOrderInput('9007199254740992');
    expect(valid).toBe(true);

    await expect(locations.create({ name: 'One past safe', walkOrder: value })).rejects.toThrow(
      /too large to be represented/i,
    );
    expect(await storedOrdinals('One past safe')).toEqual([{ ordinal: '9007199254740992' }]);
  });

  it('has the write refused outright once the ordinal outgrows an integer', async () => {
    // The far half. Every number the driver binds arrives as a REAL, and the STRICT INTEGER
    // column takes one only when it converts to an int64 exactly. This one does not, so the
    // write is refused and nothing is stored — the better of the two failures.
    const { value, valid } = resolveWalkOrderInput('1e19');
    expect(valid).toBe(true);
    expect(value).toBe(1e19);

    await expect(locations.create({ name: 'Too far', walkOrder: value })).rejects.toThrow(
      /cannot store REAL value/i,
    );
    expect(await storedOrdinals('Too far')).toEqual([]);
  });
});
