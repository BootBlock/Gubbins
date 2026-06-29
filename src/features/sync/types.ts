/**
 * Shared types for the sync engine (spec §7, Phase 7).
 *
 * Kept dependency-light (only the driver's `SqlRow`/`SqlValue` and the repository
 * `Tombstone`/`SyncTable`) so the pure reconciliation core and its tests never pull
 * in React, the worker, or a provider SDK.
 */
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncTable, Tombstone } from '@/db/repositories';

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
  /** Full append-only `item_history` ledger rows (Phase 11; resolved by union-by-id). */
  readonly itemHistory: readonly SqlRow[];
}

/** A merged gauge value to write onto an item (overrides any LWW field value). */
export interface GaugeResolution {
  readonly itemId: string;
  readonly netValue: number;
}

/** §7.5.2 conflict log: an item whose target location was gone and got re-parented. */
export interface ReparentLog {
  readonly itemId: string;
  readonly fromLocationId: string;
}

/**
 * The outcome of reconciling a local snapshot against a remote one (§7.3). Describes
 * the **local** mutations to apply atomically; the engine re-reads and pushes the
 * merged state, so the push half needs no separate diff here.
 */
export interface ReconciliationPlan {
  /** Rows to UPSERT locally (remote won LWW, or are new), already sanitised + re-parented. */
  readonly localUpserts: readonly TableRow[];
  /** Remote tombstones that won: delete the local row AND record the tombstone locally. */
  readonly localDeletes: readonly Tombstone[];
  /** Merged gauge values to set (§7.3 Delta-CRDT), applied after upserts. */
  readonly gaugeResolutions: readonly GaugeResolution[];
  /** §7.5.2 automatic re-parents to Unassigned, to log in each item's Activity Ledger. */
  readonly reparented: readonly ReparentLog[];
  /** §7.5.3 location moves discarded because they would create a nesting cycle. */
  readonly rejectedCycles: readonly string[];
  /** Phase 11: remote `item_history` rows missing locally (union-by-id), to INSERT. */
  readonly historyInserts: readonly SqlRow[];
  /** Phase 11: `item_tags` edges to add locally (membership union). */
  readonly itemTagUpserts: readonly ItemTagEdge[];
  /** Phase 11: `item_tags` edges to remove locally + tombstone (membership deletions). */
  readonly itemTagDeletes: readonly ItemTagEdgeDelete[];
}
