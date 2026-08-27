/**
 * Shared types for the sync engine (spec §7, Phase 7).
 *
 * Kept dependency-light (only the driver's `SqlRow`/`SqlValue` and the repository
 * `Tombstone`/`SyncTable`) so the pure reconciliation core and its tests never pull
 * in React, the worker, or a provider SDK.
 */
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncTable, Tombstone } from '@/db/repositories';
import type { FieldChange } from './merge-audit';

export type { SyncTable, Tombstone };

/** The schema version of the sync/backup payload (mirrors the export backup, §2). */
export const SYNC_FORMAT_VERSION = 1;

/** A table → allowed-column-names map for §7.3 payload sanitisation. */
export type SchemaDictionary = Readonly<Record<string, readonly string[]>>;

/** One row tagged with the table it belongs to. */
export interface TableRow {
  readonly table: SyncTable;
  readonly row: SqlRow;
}

/**
 * A gauge net-value delta extracted from `item_history` (§7.3 Delta-CRDT). Identified
 * by the history row's own UUID so the same physical event seen on two devices is
 * de-duplicated rather than double-counted.
 */
export interface GaugeHistoryDelta {
  readonly id: string;
  readonly itemId: string;
  readonly netValueDelta: number;
  readonly createdAt: number;
}

/** One M:N `item_tags` membership edge (no row id / timestamp — Phase 11). */
export interface ItemTagEdge {
  readonly itemId: string;
  readonly tagId: string;
}

/** An `item_tags` edge removal to apply locally + record as an edge tombstone. */
export interface ItemTagEdgeDelete extends ItemTagEdge {
  readonly deletedAt: number;
}

/** One M:N `location_tags` membership edge (no row id / timestamp — issue #84). */
export interface LocationTagEdge {
  readonly locationId: string;
  readonly tagId: string;
}

/** A `location_tags` edge removal to apply locally + record as an edge tombstone. */
export interface LocationTagEdgeDelete extends LocationTagEdge {
  readonly deletedAt: number;
}

/** One M:N `item_regions` membership edge (no row id / timestamp — issue #81). */
export interface ItemRegionEdge {
  readonly itemId: string;
  readonly regionId: string;
}

/** An `item_regions` edge removal to apply locally + record as an edge tombstone. */
export interface ItemRegionEdgeDelete extends ItemRegionEdge {
  readonly deletedAt: number;
}

/**
 * The versioned snapshot exchanged with a {@link CloudProvider}. `tables` holds the
 * full row set of every LWW syncable table (keyed by table name); `tombstones` carries
 * the §7.2 deletions (including `item_tags` edge tombstones keyed by `itemId|tagId`);
 * `gaugeHistory` carries the net-value deltas the §7.3 Delta-CRDT replays.
 *
 * Phase 11 sync-set expansion added two non-LWW sections that have no `updated_at`:
 * `itemTags` — the M:N membership edges (resolved by membership, not LWW) — and
 * `itemHistory` — the full append-only Activity Ledger (resolved by union-by-id). The
 * `item_images` thumbnails inside `tables` are base64-encoded for JSON-safety.
 *
 * Mirrors the §2 "Versioned JSON File" so a sync doc *is* a restorable backup.
 */
export interface SyncSnapshot {
  readonly formatVersion: number;
  readonly generatedAt: number;
  readonly tables: Readonly<Record<string, readonly SqlRow[]>>;
  readonly tombstones: readonly Tombstone[];
  readonly gaugeHistory: readonly GaugeHistoryDelta[];
  /** M:N `item_tags` membership edges (Phase 11; resolved by membership). */
  readonly itemTags: readonly ItemTagEdge[];
  /** M:N `location_tags` membership edges (issue #84; resolved by membership). */
  readonly locationTags: readonly LocationTagEdge[];
  /** M:N `item_regions` membership edges (issue #81; resolved by membership). */
  readonly itemRegions: readonly ItemRegionEdge[];
  /** Full append-only `item_history` ledger rows (Phase 11; resolved by union-by-id). */
  readonly itemHistory: readonly SqlRow[];
  /**
   * Full append-only `stock_deltas` ledger rows (issue #188; resolved by union-by-id). Every
   * signed change to a `(item, location, batch)` placement's quantity, replayed to converge
   * `stock_batches.quantity` instead of resolving it by Last-Write-Wins.
   */
  readonly stockDeltas: readonly SqlRow[];
}

/** A merged gauge value to write onto an item (overrides any LWW field value). */
export interface GaugeResolution {
  readonly itemId: string;
  readonly netValue: number;
}

/**
 * A signed stock movement extracted from `stock_deltas` (issue #188 Delta-CRDT). Identified by
 * the delta row's own id so the same movement seen on two devices is de-duplicated rather than
 * double-counted, exactly like {@link GaugeHistoryDelta}.
 */
export interface StockQuantityDelta {
  readonly id: string;
  readonly quantityDelta: number;
  /** Epoch-ms the movement was recorded — the replay's running order (`id` breaks a tie). */
  readonly createdAt: number;
  /**
   * The quantity **physically observed** at the placement, when this row came from a cycle count
   * rather than a movement (issue #633); `null` for every ordinary delta. An absolute count
   * supersedes the ledger before it, so the replay restarts from this figure instead of adding
   * `quantityDelta` to what came before — which is what makes counting the same shelf on two
   * devices idempotent instead of applying both corrections.
   */
  readonly assertedQuantity: number | null;
}

/**
 * A merged `(item, location, batch)` placement quantity to write onto `stock_batches` (issue #188
 * Delta-CRDT). Overrides the Last-Write-Wins value the merge upserted; the recompute triggers then
 * roll it up to `item_stock` and `items.quantity`.
 */
export interface StockResolution {
  readonly itemId: string;
  readonly locationId: string;
  readonly batchKey: string;
  readonly quantity: number;
}

/**
 * A genuine concurrent-edit collision surfaced for user review (§7.3, issue #72).
 *
 * Row-level LWW resolves every field silently by newest-timestamp-wins; that is correct
 * and lossless for the common case (only one side changed since the last sync). But when
 * **both** sides edited the *same* row since the last common sync, LWW must discard the
 * loser's work with no notice. This record captures that discarded local version so the UI
 * can tell the user "your offline edit to X lost to a concurrent change" and offer to
 * restore it — turning a silent overwrite into a reviewable, recoverable event.
 *
 * Detection is deliberately conservative (see `reconcile`): it fires only when the local
 * row changed *after* the last successful sync (so a device merely catching up never
 * reports a "conflict"), and only in the two data-losing directions — a remote row winning
 * LWW over a newer-than-last-sync local edit (`kind: 'UPDATE'`), or a remote deletion
 * winning over one (`kind: 'DELETE'`). Each device thus surfaces exactly the losses that
 * happened to *its own* work; the peer that won reports nothing, so a single physical
 * collision is never double-counted across the fleet.
 *
 * These records are device-local (not synced): they live in a persisted store, never in a
 * snapshot.
 */
export interface SyncConflict {
  /**
   * Deterministic id — `${tableName}:${rowId}:${localUpdatedAt}` — so re-detecting the same
   * discarded local version across repeated syncs de-duplicates rather than piling up.
   */
  readonly id: string;
  readonly tableName: SyncTable;
  readonly rowId: string;
  /** `'UPDATE'` — a remote edit won LWW; `'DELETE'` — a remote deletion won over a local edit. */
  readonly kind: 'UPDATE' | 'DELETE';
  /** The discarded local row (the user's work that lost) — the version a restore re-applies. */
  readonly localVersion: SqlRow;
  /** The winning remote row for an `'UPDATE'`; `null` for a `'DELETE'` (the row was removed). */
  readonly remoteVersion: SqlRow | null;
  /** A human-friendly label for the row, captured at detect time (row name/title/… or a short id). */
  readonly entityLabel: string;
  /** When the collision was detected (the sync's effective clock), ms since epoch. */
  readonly detectedAt: number;
}

/** §7.5.2 conflict log: an item whose target location was gone and got re-parented. */
export interface ReparentLog {
  readonly itemId: string;
  readonly fromLocationId: string;
}

/**
 * Issue #487 audit record: a last-write-wins merge overwrote this device's version of an item's
 * fields, and these are the values it discarded.
 *
 * Built by `reconcile` — which is where the losing local row and the winning remote row are both
 * in hand — and written to `item_history` by `applyPlan`, which derives the entry's id (the
 * derivation is asynchronous, so it cannot happen inside the pure engine).
 */
export interface MergeOverwrite {
  /** The item whose ledger the entry belongs to. */
  readonly itemId: string;
  /** `updated_at` of the discarded local version, in the local frame — half the derived id. */
  readonly losingUpdatedAt: number;
  /** `updated_at` of the adopted remote version — the other half. */
  readonly winningUpdatedAt: number;
  /** Each overwritten field, with the value discarded and the value adopted. */
  readonly changes: readonly FieldChange[];
}

/**
 * Issue #193 repair log: a serialised item's surplus open loan was closed by the merge.
 *
 * A serialised item is one physical instance, so it can be on loan to at most one borrower. Two
 * offline devices can each pass the local pre-flight guard and open a checkout, and the id-keyed
 * LWW union keeps both — so the merge closes all but the earliest, recording each here.
 */
export interface SerialisedLoanClosure {
  /** The serialised item that was on loan more than once. */
  readonly itemId: string;
  /** The surplus checkout that was closed (its `returned_at` stamped). */
  readonly closedCheckoutId: string;
  /** The checkout kept open — the one checked out first. */
  readonly keptCheckoutId: string;
}

/**
 * Issue #194 repair log: a booking cancelled because it double-booked an asset the merge unioned.
 *
 * A booking holds one identifiable unit for a span of days, so two active bookings of the same
 * asset whose day-ranges overlap are a double-booking. `AssetBookingRepository.create`'s overlap
 * guard is a read-then-write check across sibling rows, so it holds only within one device; two
 * offline devices can each pass it and the id-keyed LWW union keeps both. The merge keeps the
 * earlier-reserved booking and cancels the rest, recording each here.
 */
export interface BookingOverlapCancellation {
  /** The asset that was booked more than once over the same days. */
  readonly itemId: string;
  /** The surplus booking that was cancelled (its `cancelled_at` stamped). */
  readonly cancelledBookingId: string;
  /** The booking kept active — the one reserved first — that this one clashed with. */
  readonly keptBookingId: string;
}

/**
 * The outcome of reconciling a local snapshot against a remote one (§7.3). Describes
 * the **local** mutations to apply atomically; the engine re-reads and pushes the
 * merged state, so the push half needs no separate diff here.
 */
/**
 * Issue #187: one id retired because a peer's row won the same non-primary-key UNIQUE index —
 * a tag / contact / custom-field *name*, or a composite child key such as
 * `capabilities(item_id, key)`. Both devices reach the same verdict from the same pure rule
 * (see `unique-keys.ts`), so the retirement is symmetric rather than a local preference.
 *
 * The apply runs the DELETE + tombstone for `loserId` **before** the merge's upserts, so the
 * winner's INSERT finds the natural key free; the tombstone then propagates the retirement so
 * the losing id does not simply come back on the next sync. Anything that pointed at
 * `loserId` has already been repointed at `winnerId` in the plan's upserts, so the two
 * devices' associations merge rather than one side's being lost to the cascade.
 */
export interface CollisionResolution {
  readonly table: SyncTable;
  /** The id that lost the natural key and is retired. */
  readonly loserId: string;
  /** The id that keeps it, and that every reference to `loserId` now points at. */
  readonly winnerId: string;
  /** Tombstone instant recorded for `loserId`. */
  readonly deletedAt: number;
  /**
   * True when `loserId` was **already** being deleted by this merge (its tombstone arrived from a
   * peer) and this entry exists only to run that DELETE *ahead* of `winnerId`'s INSERT, which the
   * shared UNIQUE index would otherwise reject. It is not a naming contest, so the apply must take
   * the plain delete path — in particular it must not repoint a retired *user*'s ledger rows at
   * `winnerId`, which would re-attribute a deleted account's history to an unrelated one.
   */
  readonly hoistOnly?: boolean;
}

/**
 * Issue #707: a stored row to move off its natural key **before** the upserts run, because a
 * different incoming row takes that key while this one is itself only being renamed.
 *
 * Not a retirement and not a contest — both rows survive and both names are legitimate. The row
 * is parked on a throwaway value (its own id), and its own upsert writes the real new name a few
 * statements later in the same transaction, so the parked value is never observable. See
 * `planKeyParks` for why the ordering cannot be left to the upserts themselves.
 */
export interface KeyPark {
  readonly table: SyncTable;
  /** The free-text column of the UNIQUE index to overwrite. */
  readonly column: string;
  /** The stored row holding the key someone else is about to take. */
  readonly id: string;
}

/**
 * Issue #537: a local tombstone this merge contradicts, to delete as part of the apply.
 *
 * A row deleted here and then edited on a peer comes back down as an ordinary upsert, but the
 * tombstone recording our deletion stays behind — and `buildLocalSnapshot` reads the tombstone
 * table wholesale, so the next push publishes "this row is deleted" alongside the row itself.
 * A third device that holds neither then has a tombstone and a row under one id, and the two
 * never converge until the tombstone reaches its 180-day TTL.
 *
 * `reconcile` emits one of these for every id it resurrects that this device still holds a
 * tombstone for, mirroring what `restoreSnapshot` and the manual conflict restore already do
 * for the same hazard on their own paths.
 */
export interface TombstoneClear {
  readonly tableName: SyncTable;
  readonly id: string;
}

/**
 * Issues #157 / #192: a "one flag per parent" invariant the merge had to repair. `supplier_parts`
 * carries two independent one-of-N flags per item — `is_preferred` (drives valuation) and
 * `is_price_source` (drives which supplier a price refresh fetches) — each maintained by an
 * app-level demote-then-set. Per-row LWW cannot see across rows, so two devices that each pinned a
 * *different* supplier offline converge to two flagged rows. `reconcile` picks one deterministic
 * winner per (item, flag) and emits this so `applyPlan` clears the flag from every other row for
 * that item *before* the upserts run — otherwise the winner's write would trip the partial unique
 * index the same backstop adds at the schema level.
 */
export interface FlagRepair {
  readonly table: SyncTable;
  /** The item whose flag is being reduced to a single winner. */
  readonly itemId: string;
  /** The boolean column to clear on every row but the winner. A fixed code literal, never row data. */
  readonly column: string;
  /** The single row that keeps `column = 1`. */
  readonly winnerId: string;
}

/**
 * One item's Activity-Log clear, adopted from the merged ledger (issue #620).
 *
 * `item_history` is unioned by id, so a clear needs a mark *inside* the ledger or a peer
 * would simply hand the cleared entries back. The `HISTORY_CLEARED` entry is that mark:
 * whichever device wrote the newest one for an item, every entry older than it is out —
 * not imported from the peer, and deleted here if this device still holds it.
 */
export interface HistoryClear {
  readonly itemId: string;
  /** Instant of the newest `HISTORY_CLEARED` entry for the item; entries before it go. */
  readonly before: number;
}

export interface ReconciliationPlan {
  /** Rows to UPSERT locally (remote won LWW, or are new), already sanitised + re-parented. */
  readonly localUpserts: readonly TableRow[];
  /** Remote tombstones that won: delete the local row AND record the tombstone locally. */
  readonly localDeletes: readonly Tombstone[];
  /** Merged gauge values to set (§7.3 Delta-CRDT), applied after upserts. */
  readonly gaugeResolutions: readonly GaugeResolution[];
  /**
   * Issue #188: merged `stock_batches` placement quantities to set (discrete-stock Delta-CRDT),
   * applied after the LWW upserts to override them. The recompute triggers then re-derive
   * `item_stock` and `items.quantity`.
   */
  readonly stockResolutions: readonly StockResolution[];
  /** §7.5.2 automatic re-parents to Unassigned, to log in each item's Activity Ledger. */
  readonly reparented: readonly ReparentLog[];
  /**
   * Issue #487: the ledger entries recording what a last-write-wins merge overwrote on this
   * device. Empty unless a local edit made since the last sync lost to a newer remote one —
   * ordinary propagation of a peer's edit overwrites nothing this device had changed.
   */
  readonly mergeOverwrites: readonly MergeOverwrite[];
  /** §7.5.3 location moves discarded because they would create a nesting cycle. */
  readonly rejectedCycles: readonly string[];
  /** Issue #193: serialised items whose surplus open loans were closed (see {@link SerialisedLoanClosure}). */
  readonly serialisedLoansClosed: readonly SerialisedLoanClosure[];
  /** Issue #194: bookings cancelled because they double-booked an asset (see {@link BookingOverlapCancellation}). */
  readonly bookingsCancelled: readonly BookingOverlapCancellation[];
  /** Issue #187: ids retired to a peer's row under a shared natural key (see {@link CollisionResolution}). */
  readonly collisions: readonly CollisionResolution[];
  /** Issue #707: rows to move off a natural key another upsert takes (see {@link KeyPark}). */
  readonly keyParks: readonly KeyPark[];
  /** Issue #537: local tombstones for ids this merge resurrects (see {@link TombstoneClear}). */
  readonly tombstoneClears: readonly TombstoneClear[];
  /** Issues #157 / #192: "one flag per item" reductions to apply before the upserts (see {@link FlagRepair}). */
  readonly flagRepairs: readonly FlagRepair[];
  /**
   * Issue #191: the single location that keeps `is_default = 1` after the merge, or `null` when no
   * cross-row repair is needed (0/1 default among survivors, or every offending row is a losing
   * upsert already zeroed in place). When set, `applyPlan` runs a demoting UPDATE clearing the flag
   * on every *other* row *before* the upserts — otherwise the winner's write would trip the partial
   * unique index the same backstop adds at the schema level. Per-row LWW cannot see across rows, so
   * two devices that each nominated a *different* default converge to two flagged rows; `reconcile`
   * picks one deterministic winner (newest `updated_at`, ties broken by the smaller id so both
   * devices agree) and clears the flag everywhere else.
   */
  readonly defaultLocationWinnerId: string | null;
  /** Phase 11: remote `item_history` rows missing locally (union-by-id), to INSERT. */
  readonly historyInserts: readonly SqlRow[];
  /** Issue #620: per-item ledger clears to adopt — drop local entries older than the mark. */
  readonly historyClears: readonly HistoryClear[];
  /** Issue #188: remote `stock_deltas` rows missing locally (union-by-id), to INSERT. */
  readonly stockDeltaInserts: readonly SqlRow[];
  /** Phase 11: `item_tags` edges to add locally (membership union). */
  readonly itemTagUpserts: readonly ItemTagEdge[];
  /** Phase 11: `item_tags` edges to remove locally + tombstone (membership deletions). */
  readonly itemTagDeletes: readonly ItemTagEdgeDelete[];
  /** Issue #84: `location_tags` edges to add locally (membership union). */
  readonly locationTagUpserts: readonly LocationTagEdge[];
  /** Issue #84: `location_tags` edges to remove locally + tombstone (membership deletions). */
  readonly locationTagDeletes: readonly LocationTagEdgeDelete[];
  /** Issue #81: `item_regions` edges to add locally (membership union). */
  readonly itemRegionUpserts: readonly ItemRegionEdge[];
  /** Issue #81: `item_regions` edges to remove locally + tombstone (membership deletions). */
  readonly itemRegionDeletes: readonly ItemRegionEdgeDelete[];
  /**
   * Issue #72: genuine same-row concurrent-edit collisions where a local edit made since
   * the last sync lost to a remote change/deletion. Surfaced for user review — not applied
   * to the DB (LWW already decided the stored value); the orchestrator carries them out in
   * the {@link import('./sync-engine').SyncResult} so the UI can persist and present them.
   */
  readonly conflicts: readonly SyncConflict[];
}
