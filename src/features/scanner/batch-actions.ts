/**
 * Continuous-Mode batch actions (spec §6.3, Phase 50).
 *
 * After scanning a working queue in Continuous Mode the user applies one batch
 * action to *every* queued item — **"Check out all"** to a contact or **"Move all"**
 * to a new location (the spec's headline example: "apply a batch action (e.g., moving
 * all 3 items to a new location)"). The per-item work is async (one repository call
 * each), so it can partially fail; this pure module owns the partial-failure
 * partition ({@link runBatch}) and the screen-reader-friendly outcome summary
 * ({@link summariseBatch}), keeping the scanner-overlay glue thin and the result
 * logic unit-tested (mirrors the `cycle-count.ts` / `labels/label-sheet.ts` "logic out of
 * the glue" seam). Both queue actions route through it, so a single failed item never
 * aborts the rest and every batch reports what actually happened.
 */

/** The batch actions a Continuous-Mode working queue can be finalised with (§6.3). */
export type ContinuousBatchAction = 'CHECKOUT' | 'MOVE';

/** The success/failure partition of a finished batch, both in input order. */
export interface BatchOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Apply an async `run` to every id, tolerating per-item failure: one rejected (or
 * synchronously throwing) item never aborts the rest. Items are processed strictly in
 * input order — the repository write queue serialises OPFS transactions anyway
 * (§2.2.4) — and the returned partition preserves that order.
 */
export async function runBatch(
  ids: readonly string[],
  run: (id: string) => Promise<unknown>,
): Promise<BatchOutcome> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await run(id);
      succeeded.push(id);
    } catch {
      failed.push(id);
    }
  }
  return { succeeded, failed };
}

function plural(n: number): string {
  return n === 1 ? 'item' : 'items';
}

/**
 * A human, screen-reader-friendly summary of a finished batch (§6.3). `target` is the
 * destination label — the location name for a `MOVE`, the contact name for a
 * `CHECKOUT`. A non-zero failure count is appended so a partial success is honest.
 */
export function summariseBatch(
  action: ContinuousBatchAction,
  outcome: BatchOutcome,
  target: string,
): string {
  const n = outcome.succeeded.length;
  const base =
    n === 0
      ? action === 'MOVE'
        ? 'No items moved'
        : 'No items checked out'
      : `${action === 'MOVE' ? 'Moved' : 'Checked out'} ${n} ${plural(n)} to ${target}`;
  return outcome.failed.length > 0 ? `${base} · ${outcome.failed.length} failed` : base;
}
