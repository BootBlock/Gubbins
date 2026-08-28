/**
 * Drift guard (issue #254): the numeric item normalisers versus the storage contract of the
 * `items` columns they claim to mirror.
 *
 * Several of these guards' docstrings assert parity with a SQL CHECK — a TypeScript predicate
 * standing in for a constraint written in another language, in another file, that nothing
 * compared. That is the same risk class as the two predicates issue #156 fixed, so it gets the
 * same treatment: drive a spread of probe values through **both** and require the verdicts to
 * agree, against the schema as SQLite actually built it rather than against the DDL source text.
 *
 * The column side is deliberately the *whole* contract, not the `CHECK` alone. `items` is a
 * STRICT table, so a column refuses a value for two reasons that are indistinguishable to a
 * caller and equally fatal to a write: `depreciation_months = 0` trips the `> 0` CHECK, while
 * `depreciation_months = 0.5` trips STRICT's integer typing. A guard that only matched the CHECK
 * would still hand the write path a value the column rejects.
 *
 * "Agree" is stricter than "both reject something": a value the guard accepts must be storable,
 * and a value the guard rejects must be one the column would have refused anyway. A guard that
 * accepted more than the column would turn a friendly refusal into a constraint abort deep in a
 * write transaction; a guard that accepted *less* would quietly forbid a value the schema allows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '../../errors';
import {
  normaliseCostPerUnitOfMeasure,
  normaliseCurrentValue,
  normaliseDepreciationMonths,
  normaliseDimension,
  normalisePurchasePrice,
  normaliseUnitCost,
  normaliseWeight,
} from './normalise';

/** One guard paired with the `items` column whose CHECK it claims to mirror. */
interface Pairing {
  readonly column: string;
  readonly normalise: (value: number | null | undefined) => number | null;
}

const PAIRINGS: readonly Pairing[] = [
  { column: 'purchase_price', normalise: normalisePurchasePrice },
  { column: 'current_value', normalise: normaliseCurrentValue },
  { column: 'unit_cost', normalise: normaliseUnitCost },
  { column: 'cost_per_unit_of_measure', normalise: normaliseCostPerUnitOfMeasure },
  { column: 'weight', normalise: normaliseWeight },
  { column: 'width', normalise: (v) => normaliseDimension(v, 'Width') },
  { column: 'height', normalise: (v) => normaliseDimension(v, 'Height') },
  { column: 'depth', normalise: (v) => normaliseDimension(v, 'Depth') },
  { column: 'depreciation_months', normalise: normaliseDepreciationMonths },
];

/**
 * The values each pairing is probed with. Deliberately straddles every boundary the two sides
 * could disagree about: the null clear, zero, a fraction below one (which an integer column
 * truncates), ordinary positives, and negatives just either side of zero.
 */
const PROBES: readonly (number | null)[] = [null, 0, 0.5, 1, 12.5, 1000, -0.5, -1, -1000];

describe('item numeric normalisers ↔ the items CHECK constraints they mirror (issue #254)', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    await driver.execute("INSERT INTO locations (id, name, is_system) VALUES ('loc', 'Loc', 0);");
    // A CONSUMABLE_GAUGE probe row, complete with the gauge block the schema makes mandatory for
    // that mode. Every column under test is reachable on one row this way: `unit_cost` and the
    // asset-lifecycle columns apply to any item, while `cost_per_unit_of_measure` carries a
    // second CHECK confining it to a gauge — on a DISCRETE row it would refuse every value, and
    // the pairing would "agree" for a reason that has nothing to do with the guard.
    await driver.execute(
      `INSERT INTO items (id, name, location_id, tracking_mode, unit_of_measure,
                          gross_capacity, tare_weight, current_net_value)
       VALUES ('item', 'Item', 'loc', 'CONSUMABLE_GAUGE', 'g', 1000, 100, 500);`,
    );
  });

  afterEach(async () => {
    await driver.close();
  });

  /**
   * The two ways a column here refuses a value: its `CHECK`, and — because `items` is STRICT —
   * its declared type. Matched explicitly so anything else (a mistyped column, a closed driver,
   * a transient failure) rethrows instead of being counted as a refusal. A bare `catch` would
   * read a broken test as a passing one, which is the failure this whole file exists to prevent.
   */
  const REFUSAL = /CHECK constraint failed|cannot store .+ value in .+ column/i;

  /** Whether the column accepts `value`, written straight to the real schema. */
  async function columnAccepts(column: string, value: number | null): Promise<boolean> {
    try {
      await driver.execute(`UPDATE items SET ${column} = ? WHERE id = 'item';`, [value]);
      return true;
    } catch (err) {
      if (err instanceof DbError && REFUSAL.test(err.message)) return false;
      throw err;
    }
  }

  /** The guard's verdict on `value`: its normalised output, or `undefined` when it refuses. */
  function guardVerdict(pairing: Pairing, value: number | null): number | null | undefined {
    try {
      return pairing.normalise(value);
    } catch (err) {
      expect(err).toBeInstanceOf(DbError);
      return undefined;
    }
  }

  for (const pairing of PAIRINGS) {
    describe(`items.${pairing.column}`, () => {
      it('stores every value it accepts, and refuses only values the column would refuse', async () => {
        for (const probe of PROBES) {
          const normalised = guardVerdict(pairing, probe);
          if (normalised !== undefined) {
            // Accepted: what the guard hands the write path must satisfy the CHECK.
            expect(
              await columnAccepts(pairing.column, normalised),
              `${pairing.column} rejected the normalised form of ${probe} (${normalised})`,
            ).toBe(true);
          } else {
            // Refused: the column must agree, or the guard is narrower than the schema.
            expect(
              await columnAccepts(pairing.column, probe),
              `${pairing.column} would have accepted ${probe}, which the guard refuses`,
            ).toBe(false);
          }
        }
      });

      it('clears to NULL rather than storing a zero', async () => {
        expect(pairing.normalise(null)).toBeNull();
        expect(pairing.normalise(undefined)).toBeNull();
      });

      it('refuses a non-finite value rather than passing NaN to the column', () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          expect(() => pairing.normalise(bad)).toThrow(DbError);
        }
      });
    });
  }
});
