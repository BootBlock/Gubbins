# Discrete-stock convergence — a Delta-CRDT for the per-location/per-batch ledger (design + plan)

> **Status:** 🟢 ACTIVE — S0 (per-placement delta ledger + capture) and S1 (the convergence
> CRDT that fixes #188) shipped; S3 (wiki) done alongside them. S2 (the durable base checkpoint
> that removes the pruning fragility) is the remaining, independent hardening step. Origin: issue #188.

Every discrete stock movement (adjustment, checkout, check-in, sale, write-off, PO receipt,
project pick, kit build, transfer, cycle-count reconcile) currently converges across devices by
**whole-row Last-Write-Wins** on the `stock_batches` / `item_stock` ledger. Two devices that each
draw the same placement down concurrently converge to *one* side's result — the other side's
decrement is silently discarded, and the on-hand figure ends up too high with both movements'
history rows surviving. This is issue #188.

The consumable-gauge net value (`items.current_net_value`) already solved the identical problem
with a **Delta-CRDT** (§7.3, `delta-crdt.ts`): it must never be resolved by LWW, so instead the
engine id-unions the per-event deltas from the ledger and replays them over a fixed base. The
discrete-quantity ledger *below* every non-gauge item got no equivalent. This document designs
that equivalent, records the design forks (with a recommended resolution for each), and lays out a
phased, testable implementation.

**This is a Phase-sized, sync-core change.** A subtle error converges two devices onto a *wrong*
stock figure — silent cross-device corruption, strictly worse than the current known bug. It is
written up as a plan first (this doc) rather than implemented directly, per the repo convention
for structural work (cf. the Phase 25 / Phase 28 ledger plans).

---

## 1. What exists today (the ground truth)

The physical on-hand SSOT is a **three-level projection**, maintained entirely by triggers:

```
stock_batches   --trg_stock_batches_recompute_*-->   item_stock   --trg_item_stock_recompute_*-->   items.quantity
(item|location|batchKey)                             (item|location)                                  (grand total)
```

- `stock_batches` (`v1-initial.ts:1134-1147`) is the true SSOT: one row per `(item, location,
  batchKey)`, deterministic id `${itemId}|${locationId}|${batchKey}`, `CHECK (quantity >= 0)`,
  `UNIQUE (item_id, location_id, batch_key)`. The untracked remainder is `batchKey = ''`.
- `item_stock` (`v1-initial.ts:1064-1074`) is derived: `quantity = SUM(stock_batches.quantity)`
  per placement, id `${itemId}|${locationId}`.
- `items.quantity` is derived again: `SUM(item_stock.quantity)` per item.

Both `stock_batches` and `item_stock` are in `SYNC_TABLES` (`tombstone.ts:65-66`) and ride the
**generic LWW path** in `resolveTableMerges` (`reconcile.ts:288-339`): the newer `updated_at`
wins the whole row, so the loser's `quantity` is overwritten. Emptied rows are set to `0`, never
deleted, so a removal propagates by LWW too.

A signed per-movement audit trail **already exists** in `item_history.quantity_delta` (INTEGER,
nullable), written in the *same atomic transaction* as the stock change (`history.ts:32-52`). This
is the discrete twin of the gauge's `net_value_delta`. But it is **not sufficient to replay the
ledger**, for three reasons that this design must close:

1. **No placement dimension.** `item_history` has `item_id` but **no `location_id` and no
   `batch_key`**. `quantity_delta` records the change to the item's *grand total*, not to a
   specific batch placement — so it cannot reconstruct *where* the stock sits, which is exactly
   the grain at which the conflict happens.
2. **Transfers record no delta.** `MOVED` (`stock.ts:270`, `core.ts:556`, `assembly.ts:71`) is
   net-zero at the item level, so it writes `quantity_delta = NULL`; the per-location amounts live
   only in `metadata` JSON. A transfer is a `-q` at the source placement and `+q` at the
   destination — invisible to any delta replay today.
3. **Some writes are absolute, not relative.** Per-batch cycle-count `RECONCILED`
   (`cycle-count.ts`), `consolidateStockStatements` (whole-item move / project assemble), and the
   create/variant/assemble seeds set an *absolute* quantity via `setBatchStatement`. Their
   `item_history` delta (where one exists) does not match the physical write's sign-semantics.

The gauge CRDT plumbing this design mirrors, for reference — five coordinated seams:

| Seam | Gauge | File |
| --- | --- | --- |
| Snapshot section | `gaugeHistory: GaugeHistoryDelta[]` | `types.ts:88`, read by `readGaugeHistory` `snapshot.ts:374-392` |
| Reconcile pass | `reconcileGauges` → `reconcileGauge`/`mergeDeltas`/`replayGaugeValue` | `reconcile.ts:855-877`, `delta-crdt.ts` |
| Plan field | `gaugeResolutions: GaugeResolution[]` | `types.ts:100-103, 192` |
| Apply | `UPDATE items SET current_net_value = ?` after LWW upserts | `snapshot.ts:746-752` |
| Collision suppression | `NON_LWW_COLUMNS.items` ∋ `current_net_value`, `quantity` | `conflict-detect.ts:23-25` |

---

## 2. The core model

Converge **`stock_batches.quantity` per `(item, location, batchKey)`** (the SSOT grain), and let
the existing recompute triggers roll the result up to `item_stock` and `items.quantity`
automatically. Reconciling at the batch grain — not at `item_stock` — is mandatory: `item_stock`
is trigger-derived, so any CRDT correction written there would be immediately overwritten the next
time a `stock_batches` row changed. Batch keys are deterministic and identical across devices, so
per-key deltas commute (device A's `-3` and device B's `-2` on the same key sum to `-5`).

Every batch mutation records a **signed delta equal to its physical effect** into a delta ledger,
keyed by its own UUID (so the same event seen on two devices de-duplicates). Reconciliation then
computes each contested batch's converged quantity from those deltas — as the gauge does.

The two viable replay models differ in a way the maintainer should weigh (see §3, **Fork B**):

- **Full replay (gauge-identical):** `quantity = clamp₀(base + Σ deltas)`, recomputed from a base
  every sync. Self-correcting under the zero-floor clamp; fragile to ledger pruning (a pruned
  delta is lost from the sum).
- **Op-merge (apply-remote-ops):** `quantity = clamp₀(localQ + Σ remote-only deltas)`, where
  "remote-only" = deltas whose id is not already in the local ledger. Needs only *recent* deltas
  (never pruned), so prune-robust; but the zero-floor clamp can desynchronise `quantity` from
  `Σ deltas`, so it is not self-correcting.

Both require the same new machinery (a placement-grained signed-delta ledger); they differ only in
the arithmetic of the reconcile pass, which is a single pure function either way.

---

## 3. Design forks (decide before Phase S1)

Each fork lists the options and a **recommended** resolution. These are the questions the
implementation shouldn't silently pick for you.

### Fork A — Where does the placement-grained delta ledger live?

- **A1 (recommended): a new dedicated `stock_deltas` table.** Columns:
  `id` (UUID PK), `item_id`, `location_id`, `batch_key`, `quantity_delta` (INTEGER, signed,
  non-null), `created_at`, `actor_user_id`. Append-only + immutable trigger, unioned-by-id in
  sync exactly like `item_history` (Phase 11). Kept separate from `item_history` because: (a) it
  must carry `location_id`/`batch_key`, which the user-facing Activity Log neither has nor wants;
  (b) it needs a delta for *every* batch mutation including the absolute-write and transfer paths
  that deliberately record no `item_history.quantity_delta`; (c) it can be pruned on a different
  policy from the human-readable log (see Fork C). The cost is a second write per movement.
- **A2: extend `item_history` with nullable `location_id` + `batch_key`.** One ledger, reuses the
  existing snapshot union, prune and actor-attribution machinery. But it forces the immutable
  user-facing log to carry placement plumbing, still requires reworking the `MOVED` and
  absolute-write paths to emit replayable deltas, and entangles the CRDT's prune policy with the
  Activity Log's. Rejected on separation-of-concerns grounds.

### Fork B — Replay model: full-replay vs op-merge

- **B1 (recommended): full replay, `clamp₀(base + Σ deltas)`, mirroring `replayGaugeValue`.**
  Chosen for consistency with the existing, well-tested gauge CRDT and because it is
  **self-correcting**: concurrent over-consumption that drives `Σ` negative re-clamps to `0` on
  every replay rather than leaving a latent negative that later increments unmask. `base = 0` for
  a batch (a batch has no structural capacity; its whole life is deltas). The pruning fragility
  this introduces is handled by Fork C.
- **B2: op-merge, `clamp₀(localQ + Σ remote-only deltas)`.** Prune-robust and needs no base, but
  the zero-floor clamp desynchronises `quantity` from `Σ deltas`, so a later increment drifts.
  Would need its own reconciliation-of-the-clamp story. Rejected unless Fork C's pruning answer
  proves unworkable.

### Fork C — Pruning vs the base (only bites B1)

Full replay assumes the delta sum is *complete*. `item_history` is TTL-pruned (§7.6.3-A) to
reclaim OPFS space; if `stock_deltas` were pruned the same way, `base=0 + Σ(surviving deltas)`
would understate a long-lived batch.

- **C1 (recommended): a per-batch settled base.** Store a `base_quantity` + `base_epoch` on
  `stock_batches` (or a sidecar). When deltas older than a watermark `W` are pruned, first fold
  them into `base_quantity` (`base += Σ pruned deltas`) and advance `base_epoch = W`. Replay
  becomes `clamp₀(base_quantity + Σ deltas newer than base_epoch)`. Both devices prune at the
  same content-addressed watermark, so they compute the same base. This is the durable answer and
  the one that lets `stock_deltas` be pruned as aggressively as `item_history`.
- **C2: don't prune `stock_deltas` for live batches.** Simpler to ship first: only prune deltas
  for batch keys whose row is gone (fully consumed *and* tombstoned). Defers C1's checkpoint
  machinery. Acceptable as a Phase-S1 starting point with C1 scheduled as a follow-up.

**Recommendation:** ship **C2** in the first cut (simple, correct, only costs disk for very
long-lived batches), and schedule **C1** as the durable refinement. Note the gauge CRDT has the
*same* latent pruning fragility today and lives with it — so C2 is no worse than the shipped
precedent, and C1 improves on it.

### Fork D — Which write paths must record a delta

> **Shipped refinement (S0): trigger-based capture, superseding the builder-threading below.**
> Rather than thread a paired `stock_deltas` insert through each shared builder, S0 captures the
> delta with **triggers on `stock_batches`** (`trg_stock_batches_capture_ins/upd`) computing
> `NEW.quantity − OLD.quantity` — the actually-applied, `CHECK`-clamped change. This makes the
> invariant `quantity == Σ(deltas)` hold **by construction for every write path**, present and
> future, including the two hard cases the table below flags (`MOVED` transfers and the
> absolute-set paths `consolidateStockStatements` / per-batch `RECONCILED` / seeds) — a trigger
> sees only the net effect, so it needs no per-path arithmetic and no path can be missed. The one
> thing a trigger cannot distinguish is a *sync/backup apply* (whose `stock_batches` writes carry
> deltas that already travel in the unioned ledger) from a genuine local movement; a local-only
> `stock_delta_capture` switch, flipped off around `applyPlan` / `buildCloneStatements` /
> `restoreSnapshot`, closes that gap so an apply never double-counts. The per-path inventory below
> is retained as the record of *why* builder-threading was rejected.

Every path that mutates `stock_batches` must emit a `stock_deltas` row whose `quantity_delta`
equals the exact physical change, computed **in SQL from the live row** where the write is
absolute (mirroring `gaugeDeltaHistoryStatement`'s `(SELECT … - current_net_value …)` trick, so
an overlapping write can't make the recorded delta lie). The full inventory, from the write-path
survey:

| Kind | Paths | Delta to record |
| --- | --- | --- |
| Relative `+` | PO receipt, project receipt, check-in, location-delete re-home, kit produce/disassemble-give | `+amount` per affected `(location, batchKey)` |
| Relative `−` | checkout, sale, write-off, PO return, adjust (`−`), kit consume, FEFO draws | `−amount` per affected batch row the FEFO plan touches |
| Signed | manual adjust | `±delta` on the untracked default batch |
| **Transfer** (`MOVED`) | `transferStock`, whole-item move, project assemble→container | `−q` at each source batch, `+q` at each destination batch — **the gap #2 fix** |
| **Absolute set** | per-batch cycle-count `RECONCILED`, `consolidateStockStatements`, create/variant/assemble seeds | `newQ − oldQ` computed in SQL against the pre-write row — **the gap #3 fix** |

The natural chokepoints are the shared builders in `stock-batches.ts`
(`setBatchStatement`/`addBatchStatement`/`consumeBatchStatements`/`placementDeltaStatements`) and
`stock.ts` (`consolidateStockStatements`): threading the delta emission through *those* — rather
than each of the ~19 call sites — is what keeps the change tractable and prevents a path being
missed. Every builder already returns `SqlStatement[]`; each grows a paired `stock_deltas` insert.

### Fork E — Interaction with conflict detection (issue #72)

Once a batch quantity is CRDT-merged, a divergence in it is no longer a "lost edit". Add
`stock_batches` and `item_stock` to `NON_LWW_COLUMNS` (`conflict-detect.ts:23`) with `quantity`,
exactly as `items.quantity`/`current_net_value` are excluded — so `rowsDiffer` (`reconcile.ts:118`)
stops surfacing a merged quantity as a false `SyncConflict`. (The issue's remark that no conflict
is raised today is worth re-checking during S1: `item_stock` is *not* currently in
`NON_LWW_COLUMNS`, so a since-sync local edit whose quantity loses LWW *should* already surface a
conflict — the behaviour to verify is whether trigger-derived `item_stock` writes bump
`updated_at`/cross the `conflictSince` gate. Either way the end state is the same: CRDT-merge the
quantity, suppress the false collision.)

---

## 4. Phased plan

Each phase is independently reviewable and leaves the tree green. Stable IDs so a session can be
kicked off with "implement S2".

> **Progress:** **S0 ✅ shipped**, **S1 ✅ shipped** (these two fix #188), **S3 ✅ shipped**
> alongside them. **S2 is the remaining step** — the only reason this doc stays `🟢 ACTIVE`.
> S0 landed the capture via triggers rather than builder-threading (see the Fork D refinement
> box); S1 landed the contested-placement full-replay (`reconcileStockQuantity`) and the
> `NON_LWW_COLUMNS` suppression exactly as Fork E predicted (the `item_stock` conflict-detection
> question there resolved to "just add both quantity columns").

- **S0 — Schema + delta capture (no sync behaviour change yet). ✅ Shipped.** Add `stock_deltas`
  (Fork A1) to the v1 baseline (single squashed baseline — fold the table + immutable trigger +
  index into `v1-initial.ts` and regen the schema snapshot; see `[[migration-baseline-squashed]]`).
  Thread delta emission through the shared `stock-batches.ts` / `stock.ts` builders (Fork D),
  including the SQL-computed delta for the absolute-write and transfer paths. Assert the invariant
  in tests: after any movement, `stock_batches.quantity == Σ(stock_deltas for that key)` (pre-clamp).
  **No reconcile change** — this phase only starts *recording* the ledger, so it is safe to ship
  alone and lets the delta trail accrue before any device relies on it.
- **S1 — Snapshot + reconcile + apply (the CRDT itself). ✅ Shipped.** Add the `stockDeltas`
  union-by-id snapshot section (`readStockDeltas` over `stock_deltas`, carried like `itemHistory`),
  `reconcileStock` (batch-grained, Fork B1 replay) producing `stockResolutions:
  StockResolution[]` on the plan, and the apply loop `UPDATE stock_batches SET quantity = ? WHERE
  item_id = ? AND location_id = ? AND batch_key = ?` after the LWW upserts (letting triggers roll
  up). Add Fork E's `NON_LWW_COLUMNS` entries. Pruning per Fork C2. This is the phase that
  actually fixes #188.
- **S2 — Durable base checkpoint (Fork C1).** `base_quantity`/`base_epoch`, fold-on-prune, and the
  replay change to `base + Σ(deltas after base_epoch)`. Removes the long-lived-batch pruning
  fragility. Schedulable independently once S1 is stable.
- **S3 — Wiki + conflict-review copy. ✅ Shipped (with S1).** Updated the sync/backup wiki page to
  describe that concurrent stock movements now *merge* rather than one side winning. (S0–S2 are
  internal; only the observable convergence behaviour touches the wiki — the wiki rule triggers on
  user-visible change.)

---

## 5. Test plan (the part that makes this safe)

- **Pure reconcile unit tests** (the bulk), mirroring `delta-crdt`'s existing suite: two snapshots
  with overlapping and disjoint delta id-sets per batch key; assert converged quantity =
  `clamp₀(Σ union)`; assert idempotence (re-reconciling a converged pair is a no-op); assert the
  three-device / repeated-sync case converges; assert over-consumption floors at 0 and stays there.
- **The invariant test** from S0: property-style — apply a random sequence of every movement type,
  assert `quantity == Σ deltas` per batch at each step (pre-clamp), and `== clamp₀(Σ)` post-clamp.
- **Transfer + absolute-write regression:** a `MOVED` and a per-batch `RECONCILED` each produce
  deltas that replay back to the physical quantity.
- **Trigger roll-up:** after an applied `stockResolution`, `item_stock.quantity` and
  `items.quantity` re-derive correctly (don't assert them directly in the CRDT — assert the
  triggers did their job).
- **The issue's exact scenario** end-to-end: A checks out 3 (10→7), B checks out 4 (10→6)
  concurrently; after a round-trip sync both devices read **3**, with both checkout history rows
  present and no false `SyncConflict`.
- **`npm run smoke:bridge`** — `stock_deltas`, the builders and reconcile are bridge-imported;
  the strip-only loader must accept them (no TS param-properties/enums — see
  `[[bridge-strip-only-no-parameter-properties]]`).

---

## 6. Risks & explicitly out of scope

- **Silent corruption is the whole risk.** Every fork above is chosen to keep the merge a pure,
  exhaustively-unit-tested function over two snapshots (as the gauge CRDT is), so the dangerous
  logic never touches the DB and is testable in isolation.
- **Double-write cost.** Every movement gains one `stock_deltas` insert. Movements are already
  multi-statement transactions; the marginal cost is one row. Acceptable.
- **Redundant re-sync churn** (`[[sync-redundant-resync-churn]]`, the open LWW-tie ping-pong bug)
  is *adjacent* but separate: it concerns `updated_at`-trigger churn on tie re-upserts. A quantity
  that is now CRDT-merged rather than LWW-upserted may reduce that churn, but this plan does not
  claim to fix it — track it separately.
- **Out of scope:** gauge items (already have their CRDT), SERIALISED presence (audited by
  is_active, not a counter), and reservations/procurement rows that touch only `project_bom_lines`
  (no stock move). `UNTRACKED` items hold no ledger. None of these need a stock delta.

---

## 7. One-line origin

Issue #188 — "Concurrent stock movements silently discard one side — `item_stock.quantity` is a
counter resolved by LWW." The fix is the discrete-ledger equivalent of the §7.3 gauge Delta-CRDT,
staged as S0–S3 above.
