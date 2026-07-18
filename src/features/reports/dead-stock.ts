/**
 * Pure resolution seam for **dead-stock reporting opt-in** (issue #92).
 *
 * "Dead stock" is stock that has not moved for a long time. Flagging it is deliberately
 * **opt-in**: an inventory where every item is reported is noise, so nothing is flagged
 * until the user asks for it — either on an individual item, or on a location so that
 * everything stored there is reported without touching each item.
 *
 * Two things resolve independently through the item's location ancestry:
 *
 * - **whether** an item is reported ({@link DeadStockMode}), and
 * - **how long** it must sit idle first (the threshold in days).
 *
 * Keeping them independent is what lets a user say "report everything in the garage, but
 * only after a year" by setting the mode on one location and the threshold on another.
 *
 * Mirrors the sibling pure seams (`location-inheritance.ts`, `custom-fields.ts`,
 * `audit-session.ts`): pure, injectable, **no DB**, exhaustively unit-tested. The
 * repository walks the ancestry (via `buildAncestorChain`) and hands the result here.
 */

import { DEAD_STOCK_MODES, type DeadStockMode } from '@/db/repositories/constants';

export { DEAD_STOCK_MODES, type DeadStockMode };

/** Narrow an untrusted string (DB row, import, sync peer) to a {@link DeadStockMode}. */
export function isDeadStockMode(value: unknown): value is DeadStockMode {
  return typeof value === 'string' && (DEAD_STOCK_MODES as readonly string[]).includes(value);
}

/** One link in the item's location ancestry, ordered nearest-first, with its policy. */
export interface DeadStockLocationPolicy {
  readonly id: string;
  readonly name: string;
  /** Whether items below this location are reported; `inherit` defers further up. */
  readonly mode: DeadStockMode;
  /** This location's idle threshold in days, or null to defer further up. */
  readonly thresholdDays: number | null;
}

/** Where a resolved part of the policy came from — drives the UI's explanatory copy. */
export type DeadStockSource = 'item' | 'location' | 'default';

/** The effective dead-stock policy for one item. */
export interface ResolvedDeadStockPolicy {
  /** Whether this item should appear in the dead-stock report at all. */
  readonly reported: boolean;
  /** The idle threshold in days that applies to this item. */
  readonly thresholdDays: number;
  /** What decided {@link reported}. */
  readonly reportedSource: DeadStockSource;
  /** What decided {@link thresholdDays}. */
  readonly thresholdSource: DeadStockSource;
  /**
   * The location that decided {@link reported}, when `reportedSource` is `location` —
   * so the UI can say *"reported — inherited from Deep storage"* rather than leaving the
   * user hunting up the tree for whichever location switched it on.
   */
  readonly reportedFrom: { readonly id: string; readonly name: string } | null;
  /** The location that supplied {@link thresholdDays}, when `thresholdSource` is `location`. */
  readonly thresholdFrom: { readonly id: string; readonly name: string } | null;
}

/**
 * Resolve one item's effective dead-stock policy.
 *
 * `chain` must be ordered **nearest-first** (the item's own location, then its parent, and
 * so on to the root) — the order `buildAncestorChain` produces.
 *
 * Precedence for **whether** the item is reported:
 *
 * 1. the item's own `always` / `never`;
 * 2. else the nearest ancestor location with a non-`inherit` mode;
 * 3. else **not reported** — reporting is opt-in, so an untouched inventory stays quiet.
 *
 * Precedence for the **threshold** is resolved separately, so a location can set a house
 * threshold without also opting its contents in:
 *
 * 1. the nearest ancestor location that sets a `thresholdDays`;
 * 2. else the global preference (`defaultThresholdDays`).
 *
 * The threshold is resolved even when the item isn't reported: the editor UI shows the
 * user what *would* apply if they switched it on, which is far more useful than a blank.
 */
export function resolveDeadStockPolicy(
  itemMode: DeadStockMode,
  chain: readonly DeadStockLocationPolicy[],
  defaultThresholdDays: number,
): ResolvedDeadStockPolicy {
  let reported = false;
  let reportedSource: DeadStockSource = 'default';
  let reportedFrom: { id: string; name: string } | null = null;

  if (itemMode !== 'inherit') {
    reported = itemMode === 'always';
    reportedSource = 'item';
  } else {
    for (const link of chain) {
      if (link.mode === 'inherit') continue;
      reported = link.mode === 'always';
      reportedSource = 'location';
      reportedFrom = { id: link.id, name: link.name };
      break;
    }
  }

  let thresholdDays = defaultThresholdDays;
  let thresholdSource: DeadStockSource = 'default';
  let thresholdFrom: { id: string; name: string } | null = null;
  for (const link of chain) {
    if (link.thresholdDays == null) continue;
    thresholdDays = link.thresholdDays;
    thresholdSource = 'location';
    thresholdFrom = { id: link.id, name: link.name };
    break;
  }

  return { reported, thresholdDays, reportedSource, thresholdSource, reportedFrom, thresholdFrom };
}
