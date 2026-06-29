/**
 * The pure reconciliation engine (spec §7.3 diffing, §7.5 relational integrity).
 *
 * Given the local snapshot, the remote snapshot, a clock offset and the schema
 * dictionary, it produces a {@link ReconciliationPlan} describing the **local**
 * mutations to apply atomically:
 *
 *  - per-table LWW with tombstone resolution (§7.3) — remote rows win when strictly
 *    newer (after the §7.3 offset is applied to local timestamps), tombstones win
 *    when newer than the opposing row, and a row strictly newer than a tombstone
 *    "resurrects" (the tombstone is dropped from the merge);
 *  - §7.3 schema-dictionary sanitisation of every downloaded row;
 *  - §7.3 Delta-CRDT replay for `current_net_value` on gauges touched on both sides;
 *  - §7.5.2 re-parenting of any item whose target location did not survive the merge;
 *  - §7.5.3 rejection of location moves that would create a nesting cycle.
 *
 * The engine never touches the database — the orchestrator applies the plan and
 * re-reads the merged state to push — so it is exhaustively unit-tested in isolation.
 */
import {
  UNASSIGNED_LOCATION_ID,
  SYNC_TABLES,
  ITEM_HISTORY_TABLE,
  itemTagEdgeId,
} from '@/db/repositories';
import type { SqlRow } from '@/db/rpc/driver';
import { applyOffset } from './clock';
import { reconcileGauge } from './delta-crdt';
import { resolveLww } from './lww';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import type {
  GaugeHistoryDelta,
  GaugeResolution,
  ItemTagEdge,
  ItemTagEdgeDelete,
  ReconciliationPlan,
  ReparentLog,
  SchemaDictionary,
  SyncSnapshot,
  SyncTable,
  TableRow,
  Tombstone,
} from './types';

export interface ReconcileOptions {
  /** Offset added to every local `updated_at`/`deleted_at` before diffing (§7.3). */
  readonly offset: number;
  /** Live column sets per table for §7.3 payload sanitisation. */
  readonly dictionary: SchemaDictionary;
  /**
   * §7.6.3-A prune watermark: a remote `item_history` row older than this instant is
   * NOT re-imported, so a device that deliberately pruned its ledger keeps that space
   * reclaimed instead of re-downloading the pruned era from a peer. Defaults to 0.
   */
  readonly historyPrunedBefore?: number;
}

const EMPTY_PLAN: ReconciliationPlan = {
  localUpserts: [],
  localDeletes: [],
  gaugeResolutions: [],
  reparented: [],
  rejectedCycles: [],
  historyInserts: [],
  itemTagUpserts: [],
  itemTagDeletes: [],
};

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function rowsById(rows: readonly SqlRow[]): Map<string, SqlRow> {
  const map = new Map<string, SqlRow>();
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

/** Tombstones for one table, id → deletedAt. */
function tombstonesFor(tombstones: readonly Tombstone[], table: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tombstones) if (t.tableName === table) map.set(t.id, t.deletedAt);
  return map;
}

export function reconcile(
  local: SyncSnapshot,
  remote: SyncSnapshot | null,
  options: ReconcileOptions,
): ReconciliationPlan {
  // No remote yet — first publish. Nothing to pull; the orchestrator pushes local.
  if (remote === null) return EMPTY_PLAN;

  const { offset, dictionary } = options;

  // --- per-table LWW + tombstone resolution (§7.3) ------------------------------
  const { localUpserts, localDeletes } = resolveTableMerges(local, remote, dictionary, offset);

  // --- §4/§7.5 alias-text collision resolution ----------------------------------
  resolveAliasCollisions(local, localUpserts, localDeletes, offset);

  // --- §7.5.2 orphan re-parenting ------------------------------------------------
  const { reparented, finalItems, activeLocationIds } = reparentOrphans(
    local,
    localUpserts,
    localDeletes,
  );

  // --- §7.5.3 cyclical-nesting rejection ----------------------------------------
  const rejectedCycles = rejectLocationCycles(local, localUpserts);

  // --- §7.5 relational integrity: don't resurrect a child of a deleted parent ----
  const finalItemIds = new Set(finalItems.keys());
  const removedParents = computeRemovedParents(
    local,
    remote,
    localUpserts,
    localDeletes,
    finalItemIds,
    activeLocationIds,
  );
  enforceForeignKeys(localUpserts, removedParents);

  // --- §7.3 Delta-CRDT gauge reconciliation -------------------------------------
  const gaugeResolutions = reconcileGauges(local, remote, finalItems);

  // --- Phase 11: non-LWW sections (append-only ledger + M:N membership) ----------
  // Both reference parents (items/tags), so they are filtered to the rows that will
  // survive the merge to keep the atomic apply FK-safe.
  const finalTagIds = survivingIds('tags', local, localUpserts, localDeletes);

  const historyInserts = reconcileHistory(
    local,
    remote,
    options.dictionary[ITEM_HISTORY_TABLE],
    options.historyPrunedBefore ?? 0,
    finalItemIds,
  );
  const { itemTagUpserts, itemTagDeletes } = reconcileItemTags(
    local,
    remote,
    offset,
    finalItemIds,
    finalTagIds,
  );

  return {
    localUpserts,
    localDeletes,
    gaugeResolutions,
    reparented,
    rejectedCycles,
    historyInserts,
    itemTagUpserts,
    itemTagDeletes,
  };
}

/**
 * Per-table LWW + tombstone resolution (§7.3). For every synced table, diff the local
 * and remote snapshots id-by-id: a remote tombstone deletes the local row unless a
 * strictly-newer local row resurrects it; otherwise the newer of two concurrent rows
 * wins (remote rows are sanitised against the schema dictionary before download), and a
 * row new on the remote is downloaded unless our own (offset-adjusted) tombstone is at
 * least as new. Local-only rows are left for the push half. Returns the initial upsert
 * and delete lists, which later phases mutate in place.
 */
function resolveTableMerges(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  dictionary: SchemaDictionary,
  offset: number,
): { localUpserts: TableRow[]; localDeletes: Tombstone[] } {
  const localUpserts: TableRow[] = [];
  const localDeletes: Tombstone[] = [];

  for (const table of SYNC_TABLES) {
    const localRows = rowsById(local.tables[table] ?? []);
    const remoteRows = rowsById(remote.tables[table] ?? []);
    const localTomb = tombstonesFor(local.tombstones, table);
    const remoteTomb = tombstonesFor(remote.tombstones, table);
    const allowed = dictionary[table] ?? [];

    const ids = new Set<string>([...localRows.keys(), ...remoteRows.keys()]);

    for (const id of ids) {
      const l = localRows.get(id);
      const r = remoteRows.get(id);
      const lUpd = l ? applyOffset(num(l.updated_at), offset) : undefined;
      const rUpd = r ? num(r.updated_at) : undefined;
      const rTomb = remoteTomb.get(id);

      // Remote deleted this row.
      if (rTomb !== undefined) {
        // Local has a strictly-newer row → resurrect (keep local, drop tombstone).
        if (lUpd !== undefined && lUpd > rTomb) continue;
        // Otherwise the remote tombstone wins: delete locally + record it.
        if (l !== undefined) localDeletes.push({ tableName: table, id, deletedAt: rTomb });
        continue;
      }

      if (l && r) {
        if (resolveLww(lUpd!, rUpd!) === 'REMOTE_WINS') {
          localUpserts.push({ table, row: sanitiseRow(r, allowed) });
        }
        // LOCAL_WINS → nothing to apply; the push half carries it.
      } else if (r && !l) {
        // New on the remote (and not locally tombstoned newer) → download it.
        const lTomb = localTomb.get(id);
        const lTombOffset = lTomb !== undefined ? applyOffset(lTomb, offset) : undefined;
        if (lTombOffset !== undefined && lTombOffset >= rUpd!) continue; // our delete wins
        localUpserts.push({ table, row: sanitiseRow(r, allowed) });
      }
      // l && !r with no remote tombstone → purely local; push half carries it.
    }
  }

  return { localUpserts, localDeletes };
}

/**
 * §7.5.2 orphan re-parenting. Computes the set of items that will exist locally after the
 * merge (untouched local items minus deletes, plus upserts) and re-homes any whose target
 * location did not survive, mutating `localUpserts` in place. Returns the re-parent log
 * alongside the `finalItems` map and surviving-location set that later phases reuse.
 *
 * Note: `finalItems` retains the pre-fix row references — downstream consumers read only
 * its keys and the gauge columns, never `location_id`, so the re-parent fix lives solely
 * on the corresponding upsert.
 */
function reparentOrphans(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
): { reparented: ReparentLog[]; finalItems: Map<string, SqlRow>; activeLocationIds: Set<string> } {
  const reparented: ReparentLog[] = [];
  const activeLocationIds = computeActiveLocations(local, localUpserts, localDeletes);
  const itemUpsertIndex = new Map<string, number>();
  localUpserts.forEach((u, i) => {
    if (u.table === 'items') itemUpsertIndex.set(String(u.row.id), i);
  });

  const deletedItemIds = new Set(localDeletes.filter((d) => d.tableName === 'items').map((d) => d.id));

  // Every item that will exist locally after the merge: untouched local items +
  // items being upserted. Re-home any whose target location did not survive.
  const finalItems = new Map<string, SqlRow>();
  for (const row of local.tables.items ?? []) {
    if (!deletedItemIds.has(String(row.id))) finalItems.set(String(row.id), row);
  }
  for (const u of localUpserts) if (u.table === 'items') finalItems.set(String(u.row.id), u.row);

  for (const [id, row] of finalItems) {
    const target = String(row.location_id);
    const res = resolveLocationTarget(target, activeLocationIds);
    if (!res.reparented) continue;
    reparented.push({ itemId: id, fromLocationId: target });
    const fixed: SqlRow = { ...row, location_id: res.locationId };
    const existing = itemUpsertIndex.get(id);
    if (existing !== undefined) {
      localUpserts[existing] = { table: 'items', row: fixed };
    } else {
      localUpserts.push({ table: 'items', row: fixed });
    }
  }

  return { reparented, finalItems, activeLocationIds };
}

/**
 * §7.5 relational integrity: compute the parents that will not survive the merge, so an
 * upsert that references a *known and removed* parent can be dropped (or null-cleared).
 *
 * A hard delete cascades its children locally but records only the *parent* tombstone
 * (§7.2), so a peer still holds the orphaned child rows. Without this guard the deleting
 * device would re-download them on its next sync and the atomic apply would trip a foreign
 * key. (`enforceForeignKeys` consumes the result: it nulls a *nullable* FK instead of
 * dropping the row, mirroring the schema's ON DELETE SET NULL, e.g. a BOM line whose item
 * was removed.)
 */
function computeRemovedParents(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
  finalItemIds: ReadonlySet<string>,
  activeLocationIds: ReadonlySet<string>,
): Partial<Record<SyncTable, Set<string>>> {
  const removedCategories = removedIds(
    'categories',
    local,
    remote,
    survivingIds('categories', local, localUpserts, localDeletes),
  );
  return {
    items: removedIds('items', local, remote, finalItemIds),
    // A placement at a removed location must not be resurrected — its location's RESTRICT
    // FK would reject it (Phase 25). The active set already drives the §7.5.2 item re-parent.
    locations: removedIds('locations', local, remote, activeLocationIds),
    categories: removedCategories,
    contacts: removedIds('contacts', local, remote, survivingIds('contacts', local, localUpserts, localDeletes)),
    projects: removedIds('projects', local, remote, survivingIds('projects', local, localUpserts, localDeletes)),
    // §7.5 cascade-of-cascade (Phase 14): deleting a category cascades its category_fields
    // (which themselves leave no tombstone), so a field belonging to a removed category is
    // *also* removed — fold those in so item_field_values referencing them are guarded too.
    category_fields: cascadeRemovedFields(
      local,
      remote,
      removedCategories,
      survivingIds('category_fields', local, localUpserts, localDeletes),
    ),
  };
}

/**
 * Foreign-key references of each synced child table to a synced parent table (§7.5).
 * `nullable` mirrors the column's ON DELETE behaviour: a NOT-NULL FK (ON DELETE CASCADE)
 * means the child cannot outlive its parent (drop it); a nullable FK (ON DELETE SET NULL)
 * keeps the child with the reference cleared. `items.location_id` is intentionally absent
 * — the §7.5.2 re-parent already re-homes orphaned items to Unassigned.
 */
const FK_REFS: Partial<
  Record<SyncTable, readonly { col: string; parent: SyncTable; nullable: boolean }[]>
> = {
  items: [{ col: 'category_id', parent: 'categories', nullable: true }],
  // Per-location stock ledger (Phase 25). item_id mirrors the cascade children above —
  // drop a placement whose item was removed. location_id drops an *incoming* placement at
  // a removed location (it would trip the location's RESTRICT FK); the device's *own*
  // surviving placement at that location is instead re-homed to Unassigned by `applyPlan`
  // before the location tombstone DELETE, so local stock is preserved rather than lost.
  item_stock: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'location_id', parent: 'locations', nullable: false },
  ],
  // Per-batch ledger (Phase 28), the SSOT below item_stock. Same guards as item_stock: a
  // batch whose item was removed is dropped (CASCADE), and an *incoming* batch at a removed
  // location is dropped (its RESTRICT FK would reject it) while the device's own surviving
  // batches at that location are re-homed to Unassigned by `applyPlan` before the location
  // tombstone DELETE.
  stock_batches: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'location_id', parent: 'locations', nullable: false },
  ],
  category_fields: [{ col: 'category_id', parent: 'categories', nullable: false }],
  item_aliases: [{ col: 'item_id', parent: 'items', nullable: false }],
  item_field_values: [
    { col: 'item_id', parent: 'items', nullable: false },
    { col: 'field_id', parent: 'category_fields', nullable: false },
  ],
  item_images: [{ col: 'item_id', parent: 'items', nullable: false }],
  item_attachments: [{ col: 'item_id', parent: 'items', nullable: false }],
  capabilities: [{ col: 'item_id', parent: 'items', nullable: false }],
  checkouts: [
    { col: 'item_id', parent: 'items', nullable: false },
    // §7.5 (Phase 14): a peer hard-deleting a contact cascades its loans (ON DELETE
    // CASCADE, NOT NULL). Without this the deleting device would re-download an orphaned
    // checkout and trip the FK on its next sync.
    { col: 'contact_id', parent: 'contacts', nullable: false },
    // Phase 26: the per-location lend-from pointer. Nullable (NO ACTION) — an incoming
    // checkout whose source location did not survive the merge keeps the loan but clears
    // the pointer (the return then falls back to the item's primary location), mirroring
    // the location-delete null-out in `applyPlan` / `LocationRepository.delete`.
    { col: 'source_location_id', parent: 'locations', nullable: true },
  ],
  maintenance_schedules: [
    { col: 'item_id', parent: 'items', nullable: false },
    // Phase 30: the optional per-location scope. Nullable (NO ACTION) — an incoming
    // schedule whose scope location did not survive the merge keeps the schedule but
    // clears the pointer (it reverts to item-level), mirroring the location-delete
    // null-out in `applyPlan` / `LocationRepository.delete`.
    { col: 'location_id', parent: 'locations', nullable: true },
  ],
  project_bom_lines: [
    { col: 'project_id', parent: 'projects', nullable: false },
    { col: 'item_id', parent: 'items', nullable: true },
  ],
  // Budget categories (Phase 58): drop an incoming category whose project did not survive
  // the merge (it would trip the project's cascade FK), mirroring the BOM-line guard.
  project_budget_categories: [{ col: 'project_id', parent: 'projects', nullable: false }],
  // Expenses (Phase 58): the project_id guard mirrors the BOM line. category_id is nullable
  // (ON DELETE SET NULL) — an incoming expense whose category did not survive the merge keeps
  // the spend but clears the reference (it falls back to "uncategorised"), mirroring the
  // checkout source-location null-out.
  project_expenses: [
    { col: 'project_id', parent: 'projects', nullable: false },
    { col: 'category_id', parent: 'project_budget_categories', nullable: true },
  ],
};

/**
 * Ids of `table` that are **known** (present in either snapshot) but will not survive
 * the merge — i.e. genuinely removed parents. An id absent from both snapshots is *not*
 * "removed" (the snapshot just doesn't carry it), so its children are left untouched.
 */
function removedIds(
  table: SyncTable,
  local: SyncSnapshot,
  remote: SyncSnapshot,
  surviving: ReadonlySet<string>,
): Set<string> {
  const removed = new Set<string>();
  for (const r of local.tables[table] ?? []) {
    const id = String(r.id);
    if (!surviving.has(id)) removed.add(id);
  }
  for (const r of remote.tables[table] ?? []) {
    const id = String(r.id);
    if (!surviving.has(id)) removed.add(id);
  }
  return removed;
}

/**
 * `category_fields` that will not survive the merge: those directly removed, *plus* those
 * whose owning `category_id` was removed (the cascade a `categories` delete triggers,
 * which leaves no child tombstone). Folding the cascade in lets the FK guard also drop
 * `item_field_values` that reference a field whose category was deleted (§7.5, Phase 14).
 */
function cascadeRemovedFields(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  removedCategories: ReadonlySet<string>,
  survivingFields: ReadonlySet<string>,
): Set<string> {
  const removed = removedIds('category_fields', local, remote, survivingFields);
  for (const f of [...(local.tables.category_fields ?? []), ...(remote.tables.category_fields ?? [])]) {
    if (removedCategories.has(String(f.category_id))) removed.add(String(f.id));
  }
  return removed;
}

/**
 * Drop (or null) any upsert whose parent was removed in the merge, mutating
 * `localUpserts` in place. A NOT-NULL orphan is removed; a nullable orphan keeps the row
 * with the FK column cleared.
 */
function enforceForeignKeys(
  localUpserts: TableRow[],
  removedParents: Partial<Record<SyncTable, Set<string>>>,
): void {
  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    const refs = FK_REFS[u.table];
    if (!refs) continue;
    let row = u.row;
    let drop = false;
    for (const { col, parent, nullable } of refs) {
      const value = row[col];
      if (value === null || value === undefined) continue;
      const removed = removedParents[parent];
      if (!removed || !removed.has(String(value))) continue; // parent intact (or unknown)
      if (nullable) {
        row = { ...row, [col]: null };
      } else {
        drop = true;
        break;
      }
    }
    if (drop) localUpserts.splice(i, 1);
    else if (row !== u.row) localUpserts[i] = { table: u.table, row };
  }
}

/** Ids of a (LWW) table that survive the merge: local rows − deletes + upserts. */
function survivingIds(
  table: SyncTable,
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Set<string> {
  const ids = new Set<string>();
  for (const row of local.tables[table] ?? []) ids.add(String(row.id));
  for (const u of localUpserts) if (u.table === table) ids.add(String(u.row.id));
  for (const d of localDeletes) if (d.tableName === table) ids.delete(d.id);
  return ids;
}

/**
 * Append-only Activity Ledger reconciliation (§7.3, Phase 11). The ledger is immutable,
 * so the same event has the same UUID everywhere: simply INSERT any remote row missing
 * locally (**union-by-id**, never LWW). Two guards: a row older than the §7.6.3-A prune
 * watermark is skipped (the device deliberately reclaimed that space), and a row whose
 * `item_id` will not survive the merge is skipped (its FK parent is gone — it would
 * cascade away anyway).
 */
function reconcileHistory(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  allowedCols: readonly string[] | undefined,
  prunedBefore: number,
  finalItemIds: ReadonlySet<string>,
): SqlRow[] {
  const localIds = new Set((local.itemHistory ?? []).map((r) => String(r.id)));
  const inserts: SqlRow[] = [];
  for (const r of remote.itemHistory ?? []) {
    if (localIds.has(String(r.id))) continue;
    if (num(r.created_at) < prunedBefore) continue;
    if (!finalItemIds.has(String(r.item_id))) continue;
    inserts.push(allowedCols ? sanitiseRow(r, allowedCols) : r);
  }
  return inserts;
}

/**
 * M:N `item_tags` membership reconciliation (§7.3, Phase 11). The join has no per-row
 * timestamp, so it cannot resolve by LWW. Instead it is a **tombstone-wins union**
 * (2P-set): an edge is present after the merge iff either side still holds it AND
 * neither side carries a deletion tombstone for it. A surviving edge missing locally is
 * added (FK-guarded against the surviving item/tag sets); an edge present locally but
 * tombstoned by the peer is deleted and the (newest) tombstone adopted. A re-link is
 * only possible once the edge tombstone is TTL-pruned.
 */
function reconcileItemTags(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  offset: number,
  finalItemIds: ReadonlySet<string>,
  finalTagIds: ReadonlySet<string>,
): { itemTagUpserts: ItemTagEdge[]; itemTagDeletes: ItemTagEdgeDelete[] } {
  const localEdges = edgeSet(local.itemTags);
  const remoteEdges = edgeSet(remote.itemTags);
  const localTomb = edgeTombstones(local.tombstones, offset);
  const remoteTomb = edgeTombstones(remote.tombstones, 0);

  const keys = new Set<string>([
    ...localEdges.keys(),
    ...remoteEdges.keys(),
    ...localTomb.keys(),
    ...remoteTomb.keys(),
  ]);

  const itemTagUpserts: ItemTagEdge[] = [];
  const itemTagDeletes: ItemTagEdgeDelete[] = [];

  for (const key of keys) {
    const edge = localEdges.get(key) ?? remoteEdges.get(key)!;
    const lt = localTomb.get(key);
    const rt = remoteTomb.get(key);
    const tombstoned = lt !== undefined || rt !== undefined;
    const present = (localEdges.has(key) || remoteEdges.has(key)) && !tombstoned;
    const localHas = localEdges.has(key);

    if (present && !localHas) {
      // Add the edge locally — only if both endpoints survive the merge (FK-safe).
      if (finalItemIds.has(edge.itemId) && finalTagIds.has(edge.tagId)) {
        itemTagUpserts.push(edge);
      }
    } else if (!present && localHas) {
      // Peer removed it (we hold no tombstone, since localHas implies none) → delete +
      // adopt the winning tombstone instant.
      const deletedAt = Math.max(lt ?? 0, rt ?? 0);
      itemTagDeletes.push({ ...edge, deletedAt });
    }
  }
  return { itemTagUpserts, itemTagDeletes };
}

/** Index membership edges by their composite key. */
function edgeSet(edges: readonly ItemTagEdge[] | undefined): Map<string, ItemTagEdge> {
  const map = new Map<string, ItemTagEdge>();
  for (const e of edges ?? []) map.set(itemTagEdgeId(e.itemId, e.tagId), e);
  return map;
}

/** Edge tombstones (key → offset-adjusted deletedAt) from a tombstone list. */
function edgeTombstones(tombstones: readonly Tombstone[], offset: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tombstones) {
    if (t.tableName === 'item_tags') map.set(t.id, t.deletedAt + offset);
  }
  return map;
}

/**
 * Resolve §4 Universal-Alias-Mapping text collisions before the atomic apply. An
 * incoming alias upsert whose `alias` text already belongs to a *different* local id
 * (and that local row is not being deleted) would violate the UNIQUE(alias) index.
 * Resolve by LWW on `updated_at`: if the incoming row is newer it wins the text and
 * the local conflicting row is deleted+tombstoned; otherwise the incoming upsert is
 * dropped (the local mapping stands and the push half re-asserts it). Mutates
 * `localUpserts`/`localDeletes` in place.
 */
function resolveAliasCollisions(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: Tombstone[],
  offset: number,
): void {
  const TABLE = 'item_aliases';
  const deletedIds = new Set(localDeletes.filter((d) => d.tableName === TABLE).map((d) => d.id));
  // Surviving local alias rows, keyed by lower-cased alias text.
  const localByText = new Map<string, { id: string; updatedAt: number }>();
  for (const row of local.tables[TABLE] ?? []) {
    const id = String(row.id);
    if (deletedIds.has(id)) continue;
    localByText.set(String(row.alias).toLowerCase(), { id, updatedAt: applyOffset(num(row.updated_at), offset) });
  }

  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    if (u.table !== TABLE) continue;
    const upId = String(u.row.id);
    const text = String(u.row.alias).toLowerCase();
    const upUpd = num(u.row.updated_at);
    const hit = localByText.get(text);
    if (!hit || hit.id === upId) continue; // no clash, or it's the same row updating

    if (upUpd > hit.updatedAt) {
      // Incoming mapping wins the text → remove the local conflicting row.
      localDeletes.push({ tableName: TABLE, id: hit.id, deletedAt: upUpd });
      localByText.set(text, { id: upId, updatedAt: upUpd });
    } else {
      // Local mapping wins → discard the incoming upsert.
      localUpserts.splice(i, 1);
    }
  }
}

/** Location ids that survive the merge (plus the always-present Unassigned). */
function computeActiveLocations(
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Set<string> {
  const active = new Set<string>([UNASSIGNED_LOCATION_ID]);
  for (const row of local.tables.locations ?? []) active.add(String(row.id));
  for (const u of localUpserts) if (u.table === 'locations') active.add(String(u.row.id));
  for (const d of localDeletes) if (d.tableName === 'locations') active.delete(d.id);
  return active;
}

/**
 * Discard any location upsert whose new `parent_id` would close a nesting cycle
 * against the merged tree (§7.5.3), returning the rejected location ids. Mutates
 * `localUpserts` in place to drop the offending move (the local hierarchy stands).
 */
function rejectLocationCycles(local: SyncSnapshot, localUpserts: TableRow[]): string[] {
  const rejected: string[] = [];
  // Build the merged parent map: local rows overlaid with the winning upserts.
  const parentOf = new Map<string, string | null>();
  for (const row of local.tables.locations ?? []) {
    parentOf.set(String(row.id), row.parent_id === null ? null : String(row.parent_id));
  }
  for (const u of localUpserts) {
    if (u.table === 'locations') {
      parentOf.set(String(u.row.id), u.row.parent_id === null ? null : String(u.row.parent_id));
    }
  }

  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    if (u.table !== 'locations') continue;
    const id = String(u.row.id);
    const newParent = u.row.parent_id === null ? null : String(u.row.parent_id);
    if (wouldCreateCycle(id, newParent, parentOf)) {
      rejected.push(id);
      // Restore the local parent edge and drop the upsert.
      const localRow = (local.tables.locations ?? []).find((r) => String(r.id) === id);
      parentOf.set(id, localRow && localRow.parent_id !== null ? String(localRow.parent_id) : null);
      localUpserts.splice(i, 1);
    }
  }
  return rejected;
}

/** §7.3 Delta-CRDT: replay merged gauge deltas for items present on both sides. */
function reconcileGauges(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  finalItems: ReadonlyMap<string, SqlRow>,
): GaugeResolution[] {
  const resolutions: GaugeResolution[] = [];
  const localItems = rowsById(local.tables.items ?? []);
  const remoteItems = rowsById(remote.tables.items ?? []);
  const localDeltas = byItem(local.gaugeHistory);
  const remoteDeltas = byItem(remote.gaugeHistory);

  for (const [id, row] of finalItems) {
    if (String(row.tracking_mode) !== 'CONSUMABLE_GAUGE') continue;
    // Only the concurrent case needs delta replay; a one-sided gauge keeps its LWW value.
    if (!localItems.has(id) || !remoteItems.has(id)) continue;
    const gross = num(row.gross_capacity);
    if (!Number.isFinite(gross)) continue;
    const netValue = reconcileGauge(gross, localDeltas.get(id) ?? [], remoteDeltas.get(id) ?? []);
    resolutions.push({ itemId: id, netValue });
  }
  return resolutions;
}

function byItem(deltas: readonly GaugeHistoryDelta[]): Map<string, GaugeHistoryDelta[]> {
  const map = new Map<string, GaugeHistoryDelta[]>();
  for (const d of deltas) {
    const list = map.get(d.itemId) ?? [];
    list.push(d);
    map.set(d.itemId, list);
  }
  return map;
}

export { SYNC_TABLES };
export type { SyncTable };
