/**
 * seed-data — generate a batch of obviously-synthetic inventory items.
 *
 * The known ceiling on Gubbins' attention/scanning work only shows up at volume, and a realistic
 * list is otherwise something you have to build by hand. This produces one on demand.
 *
 * Two rules shape everything here:
 *  - **The data is invented, never sampled.** Names, manufacturers and part numbers come from
 *    fixed word lists; nothing is scraped from the user's real inventory or from anywhere else.
 *    (Public-repository hygiene: sample data is always synthetic.)
 *  - **The items announce themselves.** Every generated item is prefixed with {@link SEED_PREFIX}
 *    so it is obvious in a list, trivially searchable, and easy to delete afterwards. This is the
 *    one lab feature that writes to the user's real database, so it must never leave them
 *    wondering which items were theirs.
 *
 * Pure generation only — the caller does the inserting, so this stays unit-testable with no
 * database in the picture.
 */
import type { CreateItemInput } from '@/db/repositories/types/items';

/** Marks every generated item so it can be spotted and cleaned up. Do not change casually. */
export const SEED_PREFIX = 'SAMPLE';

/** Offered batch sizes, smallest first. The big ones exist to probe the list/virtualisation limits. */
export const SEED_COUNTS = [100, 1_000, 10_000] as const;

export type SeedCount = (typeof SEED_COUNTS)[number];

/** Largest batch this module will produce in one call, whatever it is asked for. */
export const SEED_MAX = 10_000;

const KINDS = [
  'Resistor',
  'Capacitor',
  'Bracket',
  'Bearing',
  'Fastener',
  'Connector',
  'Gasket',
  'Spindle',
  'Bushing',
  'Grommet',
  'Washer',
  'Terminal',
] as const;

const QUALIFIERS = ['Steel', 'Brass', 'Nylon', 'Ceramic', 'Alloy', 'Composite', 'Copper'] as const;

const MAKERS = [
  'Northwind Components',
  'Example Industrial',
  'Placeholder Supply Co',
  'Testbench Works',
  'Sample Fabrication',
] as const;

/**
 * A deterministic 32-bit hash used as the pseudo-random source, so a given index always produces
 * the same item. Deterministic on purpose: a seeded run is reproducible, and the tests can assert
 * exact output without stubbing `Math.random`.
 */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Pick from a list by index-derived hash, offset so different fields don't move in lockstep. */
function pick<T>(list: readonly T[], index: number, salt: number): T {
  return list[hash(index * 31 + salt) % list.length] as T;
}

/**
 * Build `count` synthetic item inputs. Clamped to [1, {@link SEED_MAX}] so a malformed caller
 * can't ask for a batch that would lock the UI up; a non-integer count is floored.
 */
export function buildSeedItems(count: number): CreateItemInput[] {
  const n = Math.min(SEED_MAX, Math.max(1, Math.floor(count) || 1));
  const items: CreateItemInput[] = [];
  for (let i = 0; i < n; i++) {
    const kind = pick(KINDS, i, 1);
    const qualifier = pick(QUALIFIERS, i, 2);
    const maker = pick(MAKERS, i, 3);
    // Sequence number is 1-based and zero-padded so the generated names sort naturally in a list.
    const seq = String(i + 1).padStart(5, '0');
    items.push({
      name: `${SEED_PREFIX} ${qualifier} ${kind} ${seq}`,
      description: `Synthetic item ${seq} generated for testing. Safe to delete.`,
      manufacturer: maker,
      mpn: `${SEED_PREFIX}-${seq}`,
      quantity: hash(i * 31 + 4) % 40,
      unitCost: Math.round(hash(i * 31 + 5) % 20_000) / 100,
    });
  }
  return items;
}
