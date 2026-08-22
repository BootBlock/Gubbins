/**
 * §7.5 **natural-key collision resolution** (issue #187).
 *
 * Several synced tables carry a UNIQUE index that is *not* the primary key while their rows
 * are created with `crypto.randomUUID()`. Two offline devices that each create a tag "Bolts"
 * — or a contact "Alex Smith", or the custom field "Voltage" — end up with two different ids
 * sharing one natural key. The per-table LWW pass sees the peer's id as new-on-remote and
 * emits an upsert, but the upsert's only conflict target is `id`, so the INSERT raises
 * `SQLITE_CONSTRAINT_UNIQUE` and takes the whole atomic merge down with it. Because the
 * watermark never advances, every later sync recomputes the identical failing plan: sync is
 * bricked rather than degraded.
 *
 * This module resolves those collisions **before** the apply, on the same last-write-wins
 * footing as the rest of §7.3: for each natural key, one row wins and the other's id is
 * retired. Retiring an id is not the same as discarding the row's meaning — two devices that
 * each invented "Bolts" both meant *the same tag* — so a loser that other rows point at is
 * **re-keyed**, not merely dropped: every reference is repointed at the winner and the two
 * sides' associations merge into one. That is what a user expects to see after the merge
 * (one "Bolts" tag carrying both devices' items), and it is why a bare delete would be
 * wrong: the FKs are `ON DELETE CASCADE`, so dropping the loser would silently take its
 * item links, field values or checkout history with it.
 *
 * The winner is chosen by `updated_at`, ties broken by the lexicographically smaller id.
 * The tiebreak is not cosmetic: both devices run this same pure resolution over the same
 * pair, so the choice **must not depend on which side is "local"**. A local-wins tie would
 * have each device keep its own row and re-push it forever.
 *
 * Not every entry this emits is a contest. A *third* device receives the peer's tombstone for
 * the loser alongside the winner's row, so there is nothing left to decide — but because
 * `applyPlan` orders tombstone DELETEs after the UPSERTs, the doomed row is still holding the
 * natural key when the winner's INSERT runs, and the constraint aborts the merge exactly as
 * before. Those are emitted as `hoistOnly` resolutions: they carry no verdict and retire
 * nothing, they only pull the already-decided DELETE forward. See `doomedByKey` below.
 *
 * A contest is not the only way an apply meets one of these indexes. Two rows can simply *swap*
 * their names, and neither has lost anything: the constraint is tripped only because the row
 * still physically holding a name is the one this same apply is renaming. That is an ordering
 * problem rather than a verdict, and `planKeyParks` answers it separately (issue #707).
 */
import type { SqlRow } from '@/db/rpc/driver';
import { foldName } from '@/lib/name-fold';
import { applyOffset } from './clock';
import type { CollisionResolution, KeyPark, SyncSnapshot, SyncTable, TableRow, Tombstone } from './types';

/**
 * The one part of a snapshot this resolution reads: the per-table rows already on this device.
 *
 * Narrower than {@link SyncSnapshot} on purpose (issue #538). The delta merge passes its full
 * local snapshot, but the §2 merge restore has no snapshot to pass — it reads only the tables
 * {@link UNIQUE_KEY_TABLES} names — and the TTL clone passes the *remote* it has just written
 * over the wiped tables. All three are the same question ("what rows already hold these natural
 * keys?"), so the parameter asks for that and nothing more.
 */
export type LocalTables = Pick<SyncSnapshot, 'tables'>;

/** An inbound FK whose column points at a table resolved here, to repoint on a re-key. */
interface UniqueKeyReference {
  readonly table: SyncTable;
  readonly column: string;
}

interface UniqueKeySpec {
  readonly table: SyncTable;
  /** The columns forming the UNIQUE index. */
  readonly columns: readonly string[];
  /** Of those, the ones the index declares `COLLATE NOCASE`. */
  readonly nocase: readonly string[];
  /**
   * Rows that reference this table and must follow a re-keyed id. Empty means the table's
   * rows are pointed at by nothing, so a losing row can simply be retired.
   */
  readonly references: readonly UniqueKeyReference[];
  /**
   * The free-text column of the index that a stored row can be moved off onto a throwaway value,
   * so another row may take the key it is still holding (see {@link planKeyParks}).
   *
   * Absent where no column can carry one: the four specs keyed entirely on foreign keys, where
   * writing a throwaway id into a column would trip the FK rather than free anything. Those
   * tables cannot express the rename this parks around in any case — a value row's endpoints are
   * chosen by picking a field or a component, not typed as a name. A composite key that *does*
   * carry free text names that column: `capabilities` parks on `key`, leaving `item_id` alone.
   */
  readonly parkColumn?: string;
}

/**
 * Every non-primary-key UNIQUE index across {@link SYNC_TABLES}, in resolution order.
 *
 * **Order matters.** The three dictionaries come first because re-keying one of them can
 * *create* a collision in the composite-key tables below it — repointing two devices'
 * "Voltage" definitions at a single `def_id` can leave one item holding two values for it,
 * which `UNIQUE(item_id, def_id)` then rejects. Resolving the dictionaries first means the
 * child passes see the repointed rows and settle those follow-on collisions in the same run.
 *
 * `item_stock`, `stock_batches` and `item_relations` are deliberately absent: their ids are
 * derived from the natural key itself, so concurrent creation converges on one id and
 * resolves by ordinary LWW with no collision to resolve.
 */
const UNIQUE_KEY_SPECS: readonly UniqueKeySpec[] = [
  // --- dictionaries: referenced by other rows, so a loser is re-keyed, never just dropped ---
  {
    table: 'field_defs',
    columns: ['name'],
    nocase: ['name'],
    parkColumn: 'name',
    references: [
      { table: 'category_fields', column: 'def_id' },
      { table: 'location_field_values', column: 'def_id' },
      { table: 'item_field_values', column: 'def_id' },
    ],
  },
  // `tags` is referenced by the M:N `item_tags` / `location_tags` joins, which carry no `id`
  // and are reconciled by membership rather than LWW. They cannot be repointed as rows, so
  // the caller maps their edges through this table's re-key map instead (see `reconcile`).
  { table: 'tags', columns: ['name'], nocase: ['name'], references: [], parkColumn: 'name' },
  // `roles` before `users` so a role re-key settles before users are resolved against it —
  // the same dictionaries-first ordering the block comment above describes.
  {
    table: 'roles',
    columns: ['name'],
    nocase: ['name'],
    parkColumn: 'name',
    references: [{ table: 'users', column: 'role_id' }],
  },
  // `users.username` is UNIQUE NOCASE over random-UUID ids, so two devices inventing the same
  // username would otherwise collide on the merge INSERT and brick sync (issue #79).
  //
  // `item_history.actor_user_id` cannot be listed in `references`: that field is typed
  // `SyncTable` and `repointReferences` reads `local.tables[…]`, which never holds
  // `item_history` (it travels on `snapshot.itemHistory`). This is exactly the `tags`
  // situation described above, and is handled the same way — `reconcile` pulls this table's
  // re-key map out and applies it to the ledger itself via `resolveActor`.
  //
  // `location_history.actor_user_id` is the *other* half of that ledger and **is** listed: it is
  // a synced table present in `local.tables`, so unlike `item_history` it can be repointed as a
  // row, and its `ON DELETE SET DEFAULT` would otherwise re-attribute this device's location
  // history to System — the same loss, on the same reasoning (issue #679).
  //
  // `api_tokens.user_id` is deliberately **absent**, though it could be listed. Its
  // `ON DELETE CASCADE` revokes the loser's Bridge / Home Assistant tokens, and that is the
  // right outcome: attribution says *who did this* and belongs with the surviving account, but a
  // token is a credential, and a credential must not silently change which principal it
  // authenticates as. The fold is wider than a case fold — it merges Turkish `ı` with `i` — so
  // the two rows are not certainly the same person, and the winner may be enabled where the
  // loser was suspended. Revoking is recoverable and visible (the integration starts failing to
  // authenticate); transferring is neither.
  {
    table: 'users',
    columns: ['username'],
    nocase: ['username'],
    parkColumn: 'username',
    references: [{ table: 'location_history', column: 'actor_user_id' }],
  },
  {
    table: 'contacts',
    columns: ['name'],
    nocase: ['name'],
    parkColumn: 'name',
    references: [
      { table: 'checkouts', column: 'contact_id' },
      { table: 'asset_bookings', column: 'contact_id' },
    ],
  },
  // --- composite-key children: nothing points at these, so a loser is simply retired ---
  { table: 'category_fields', columns: ['category_id', 'def_id'], nocase: [], references: [] },
  { table: 'location_field_values', columns: ['location_id', 'def_id'], nocase: [], references: [] },
  { table: 'item_field_values', columns: ['item_id', 'def_id'], nocase: [], references: [] },
  { table: 'capabilities', columns: ['item_id', 'key'], nocase: ['key'], references: [], parkColumn: 'key' },
  // Kit → component edges (issue #151). Unlike `item_relations` (absent above because its id is
  // derived from its endpoints) a kit edge carries a random UUID, so two devices adding the same
  // component to the same kit invent two ids for one `UNIQUE (kit_item_id, component_item_id)`
  // pair. Nothing references a kit edge, so the loser is simply retired.
  { table: 'kit_components', columns: ['kit_item_id', 'component_item_id'], nocase: [], references: [] },
  // §4 Universal Alias Mapping — the one table whose text collisions were always resolved.
  { table: 'item_aliases', columns: ['alias'], nocase: ['alias'], references: [], parkColumn: 'alias' },
];

/**
 * Every natural-key column this module folds through `lib/name-fold`, as `table.column`.
 *
 * The fold here is wider than the `COLLATE NOCASE` index it resolves against, so it is only
 * safe while **every write path for these columns folds the same way** — otherwise the app
 * stores two rows the merge believes are one, and the merge it then plans trips the constraint
 * it exists to route around (issue #679). Exported so a drift test can hold the two in step: a
 * new NOCASE spec added above fails that test until its write path is converted too.
 */
export const FOLDED_UNIQUE_COLUMNS: readonly string[] = UNIQUE_KEY_SPECS.flatMap((spec) =>
  spec.nocase.map((column) => `${spec.table}.${column}`),
);

/**
 * Every table {@link resolveUniqueKeyCollisions} reads out of the "local" snapshot it is given:
 * the contested tables themselves, plus the tables whose rows must follow a re-keyed id.
 *
 * The delta merge hands it a full local snapshot and never needs this. The §2 merge restore does
 * (issue #538): it holds no snapshot of its own, so it reads exactly these tables and nothing
 * else — a backup restore has no reason to pay for the image thumbnails or the ledger. Derived
 * from the specs rather than written out, so a table added above cannot be silently left unread,
 * which would make its collisions invisible instead of resolved.
 */
export const UNIQUE_KEY_TABLES: readonly SyncTable[] = [
  ...new Set(UNIQUE_KEY_SPECS.flatMap((spec) => [spec.table, ...spec.references.map((r) => r.table)])),
];

/** A row competing for one natural key: either a surviving local row or a pending upsert. */
interface Candidate {
  readonly id: string;
  readonly updatedAt: number;
  /** Index into `localUpserts`, when this candidate is a pending upsert rather than a local row. */
  readonly upsertIndex?: number;
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

/**
 * The natural key of `row` under `spec`, NOCASE columns folded and `|`-joined.
 *
 * Folding goes through the same `lib/name-fold` seam the write paths use (issues #343, #679), so
 * a merge reaches the same verdict about "is this the same name?" that the app reached when
 * it refused to create the duplicate locally. Agreeing exactly is what keeps the two from
 * disputing a row forever.
 *
 * It does **not** agree with the `UNIQUE (… COLLATE NOCASE)` index, and cannot: that folds ASCII
 * A–Z, and no driver this app runs on has the ICU extension to widen it. So this is deliberately
 * the *wider* of the two — a pair the index accepted is resolved here as the one name it always
 * was, rather than left to trip the constraint mid-merge. That only holds while every write path
 * folds this way too; `FOLDED_UNIQUE_COLUMNS` and its drift test are what keep it true.
 */
function keyOf(spec: UniqueKeySpec, row: SqlRow): string {
  return spec.columns
    .map((col) => {
      const raw = String(row[col] ?? '');
      return spec.nocase.includes(col) ? foldName(raw) : raw;
    })
    .join('|');
}

/**
 * Pick the row that keeps the natural key. Newest `updated_at` wins; an exact tie is broken
 * by the lexicographically smaller id so that **both** devices reach the same verdict — see
 * the module note on why a local-wins tie would ping-pong forever.
 */
function winnerOf(a: Candidate, b: Candidate): { winner: Candidate; loser: Candidate } {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  return a.id < b.id ? { winner: a, loser: b } : { winner: b, loser: a };
}

/**
 * Settle a contest between two rows holding one natural key: record the verdict, retire the
 * loser's id onto the winner's, and return the winner as the new holder of the key.
 *
 * A losing *upsert* must not be applied at all (it is dropped from the plan); a losing *local*
 * row is deleted ahead of the winner's INSERT so the key is free by the time it runs. Re-key
 * chains are collapsed as they form — a third row can beat the current holder, and anything
 * already pointed at that holder must follow through to the new winner rather than at a
 * now-retired id. Both `id` columns of a UNIQUE index are unique per side, so three-way
 * contention needs a re-keyed row to join an existing pair; collapsing anyway keeps that a
 * local detail rather than a correctness dependency of the spec order.
 */
function retire(
  spec: UniqueKeySpec,
  held: Candidate,
  challenger: Candidate,
  rekey: Map<string, string>,
  droppedUpserts: Set<number>,
  collisions: CollisionResolution[],
): Candidate {
  const { winner, loser } = winnerOf(held, challenger);
  if (loser.upsertIndex !== undefined) droppedUpserts.add(loser.upsertIndex);
  for (const [from, to] of rekey) if (to === loser.id) rekey.set(from, winner.id);
  rekey.set(loser.id, winner.id);
  collisions.push({
    table: spec.table,
    loserId: loser.id,
    winnerId: winner.id,
    deletedAt: Math.max(winner.updatedAt, loser.updatedAt),
  });
  return winner;
}

/**
 * Resolve every natural-key collision the merge would otherwise trip, mutating `localUpserts`
 * in place (losing upserts are dropped, references to a retired id are repointed, and local
 * rows that would have been lost to a cascade are re-emitted against the winner).
 *
 * Returns the retired ids for the apply to delete + tombstone ahead of the upserts, and the
 * per-table `loser → winner` maps the caller needs to follow the `tags` re-keys through the
 * M:N edge sections.
 */
export function resolveUniqueKeyCollisions(
  local: LocalTables,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
  offset: number,
): { collisions: CollisionResolution[]; rekeys: Map<SyncTable, Map<string, string>> } {
  const collisions: CollisionResolution[] = [];
  const rekeys = new Map<SyncTable, Map<string, string>>();

  for (const spec of UNIQUE_KEY_SPECS) {
    const rekey = resolveTable(spec, local, localUpserts, localDeletes, offset, collisions);
    if (rekey.size > 0) {
      rekeys.set(spec.table, rekey);
      repointReferences(spec, local, localUpserts, rekey);
    }
  }

  return { collisions, rekeys };
}

/**
 * Order the upserts around a **rename swap**: every stored row that must be moved off its
 * current natural key before another incoming row can take it (issue #707).
 *
 * The contest above settles *who keeps a key* when two rows claim one. It says nothing about
 * *when* each write lands, and it deliberately skips a stored row whose id this apply also
 * upserts — the pending row supersedes the stored one, so seeding both would have a row collide
 * with its own update. That is right for the contest and wrong for the index: the stored row is
 * still physically sitting on its old name at the moment the upserts run. Rename tag `A` from
 * "Fixings" to "Tools" and tag `B` from "Tools" to "Spares" on one device, and the two upserts
 * are ordered only by `SYNC_TABLES` position and source order, so `A`'s new name can land while
 * `B` still holds it — `UNIQUE constraint failed: tags.name`, and the whole atomic apply is lost.
 *
 * There is no contest to resolve here. Both names are legitimately the peer's and both rows
 * survive; what is missing is only an ordering guarantee. So this parks the holder on a
 * throwaway value (its own id, which no natural key can equal) *before* the upserts, and lets
 * the holder's own upsert write the real new name a few statements later, inside the same
 * transaction. The parked value is never observable — the same trick a retired user or tag
 * already uses to break the delete-before-insert cycle.
 *
 * Parking every holder in a cycle is what makes the result independent of upsert order: a
 * three-way rotation frees all three names up front, so whichever INSERT runs first finds its
 * name vacant.
 *
 * Call this on the **final** upsert set, after every pass that can drop a row. A parked row is
 * restored only by its own upsert, so parking one whose upsert a later pass then removes would
 * leave the throwaway id standing as the user-visible name.
 */
export function planKeyParks(local: LocalTables, upserts: readonly TableRow[]): KeyPark[] {
  const parks: KeyPark[] = [];

  for (const spec of UNIQUE_KEY_SPECS) {
    const parkColumn = spec.parkColumn;
    if (parkColumn === undefined) continue;

    // The incoming key of every row this apply writes, and who takes each key. At most one
    // upsert can hold a given key by the time this runs — the contest has already retired any
    // rival — so one id per key is exact rather than a last-writer-wins approximation.
    const incomingKeyById = new Map<string, string>();
    const takerByKey = new Map<string, string>();
    for (const u of upserts) {
      if (u.table !== spec.table) continue;
      const id = String(u.row.id);
      const key = keyOf(spec, u.row);
      incomingKeyById.set(id, key);
      takerByKey.set(key, id);
    }
    if (incomingKeyById.size === 0) continue;

    for (const row of local.tables[spec.table] ?? []) {
      const id = String(row.id);
      const incomingKey = incomingKeyById.get(id);
      // A stored row this apply does *not* upsert keeps its key, so it is a genuine rival and
      // the contest has already retired whichever side lost. Nothing to free here.
      if (incomingKey === undefined) continue;
      const storedKey = keyOf(spec, row);
      if (storedKey === incomingKey) continue; // not renamed — it is entitled to hold the key
      const taker = takerByKey.get(storedKey);
      if (taker === undefined || taker === id) continue; // nobody is waiting on the old key
      parks.push({ table: spec.table, column: parkColumn, id });
    }
  }

  return parks;
}

/** Resolve one table's collisions, returning its `loser id → winner id` map. */
function resolveTable(
  spec: UniqueKeySpec,
  local: LocalTables,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
  offset: number,
  collisions: CollisionResolution[],
): Map<string, string> {
  const rekey = new Map<string, string>();
  // Where this table's verdicts start, so the chain collapse at the end of this function rewrites
  // only its own and leaves an earlier table's alone (`collisions` is shared across the specs).
  const firstVerdict = collisions.length;
  const deletedAtById = new Map<string, number>();
  for (const d of localDeletes) if (d.tableName === spec.table) deletedAtById.set(d.id, d.deletedAt);
  const deletedIds = new Set(deletedAtById.keys());

  // Ids this merge already upserts: their pending row supersedes the stored one, so seeding
  // the stored values too would have a row collide with its own update.
  const upsertedIds = new Set<string>();
  for (const u of localUpserts) if (u.table === spec.table) upsertedIds.add(String(u.row.id));

  const byKey = new Map<string, Candidate>();
  const droppedUpserts = new Set<number>();

  /**
   * Local rows this merge *deletes*, by natural key. They do not compete for the key — they are
   * on their way out — but they still **hold** it at the moment the upserts run, because
   * `applyPlan` orders tombstone DELETEs after the UPSERTs. So a winner arriving to take a key a
   * doomed row still occupies would trip the UNIQUE index and abort the whole atomic merge. This
   * is the third-device shape of issue #187: a peer already retired the loser, so its tombstone
   * arrives *alongside* the winner and no collision is detected here. Recording it as a
   * `hoistOnly` resolution is what pulls the loser's DELETE ahead of the winner's INSERT.
   *
   * A **list** per key, not one row: the fold here is wider than the index's, so a legacy
   * database can hold several doomed rows under one folded key (`Café`, `CAFÉ`) of which only
   * some block the incoming winner. Keeping one arbitrarily could hoist a row that was not in
   * the way and leave behind the one that was (issue #679).
   */
  const doomedByKey = new Map<string, string[]>();

  /**
   * Pull every doomed row's DELETE ahead of `winnerId`'s INSERT, and stop tracking the key.
   *
   * Called wherever an *upsert* ends up holding a key — including when it took the key by
   * winning a contest. Under an exact fold that second path was unreachable, because a doomed
   * row and a surviving row could not share a key the index had already refused to duplicate.
   * This fold is wider than the index's, so they can (issue #679), and a winner INSERTing over
   * a doomed row still holding its key aborts the merge exactly as issue #187 described.
   */
  const hoistDoomed = (key: string, winnerId: string): void => {
    const doomed = doomedByKey.get(key);
    if (doomed === undefined) return;
    doomedByKey.delete(key);
    for (const loserId of doomed) {
      collisions.push({
        table: spec.table,
        loserId,
        winnerId,
        deletedAt: deletedAtById.get(loserId)!,
        hoistOnly: true,
      });
    }
  };

  // Surviving local rows stake their claim on the natural key first.
  for (const row of local.tables[spec.table] ?? []) {
    const id = String(row.id);
    if (upsertedIds.has(id)) continue;
    const key = keyOf(spec, row);
    if (deletedIds.has(id)) {
      const doomed = doomedByKey.get(key);
      if (doomed) doomed.push(id);
      else doomedByKey.set(key, [id]);
      continue;
    }
    const candidate: Candidate = { id, updatedAt: applyOffset(num(row.updated_at), offset) };
    const held = byKey.get(key);
    if (held === undefined) {
      byKey.set(key, candidate);
      continue;
    }
    // Two *local* rows on one folded key (issue #679). The index cannot have refused them —
    // it folds ASCII A–Z, so `Café Ltd` and `CAFÉ LTD` are distinct to it and both are legal —
    // but this resolution folds the whole of Unicode, exactly as the write paths now do. Left
    // to overwrite each other in `byKey` they would silently drop one from the resolution
    // entirely, and an inbound row taking the key would then INSERT against the survivor the
    // merge never retired, aborting it on the very constraint this exists to route around.
    // Contesting them is also the only path by which such a pair, already stored, is ever
    // cleaned up: the loser is re-keyed onto the winner, so its loans and values follow rather
    // than cascading away.
    byKey.set(key, retire(spec, held, candidate, rekey, droppedUpserts, collisions));
  }

  for (let i = 0; i < localUpserts.length; i += 1) {
    const u = localUpserts[i]!;
    if (u.table !== spec.table) continue;
    const candidate: Candidate = {
      id: String(u.row.id),
      updatedAt: num(u.row.updated_at),
      upsertIndex: i,
    };
    const key = keyOf(spec, u.row);
    const held = byKey.get(key);

    if (held === undefined || held.id === candidate.id) {
      // Free the key from every doomed row still sitting on it (see `doomedByKey`). Not a
      // contest — the rows are already tombstoned — so they take no `rekey` entry and nothing is
      // repointed at the newcomer; the records exist purely to order those DELETEs first. None
      // can be this candidate itself: an id this merge upserts never enters `doomedByKey`.
      hoistDoomed(key, candidate.id);
      byKey.set(key, candidate);
      continue;
    }

    const winner = retire(spec, held, candidate, rekey, droppedUpserts, collisions);
    // A winning *upsert* still has an INSERT to run, so it needs the key freed too; a winning
    // local row is already sitting on it and inserts nothing.
    if (winner.upsertIndex !== undefined) hoistDoomed(key, winner.id);
    byKey.set(key, winner);
  }

  if (droppedUpserts.size > 0) {
    const kept = localUpserts.filter((_, i) => !droppedUpserts.has(i));
    localUpserts.length = 0;
    localUpserts.push(...kept);
  }

  // Collapse re-key chains in the recorded verdicts, as `retire` already does in `rekey` itself.
  // A verdict pushed earlier names the winner of *that* contest, and a third row on the same
  // folded key can beat it afterwards — at which point that id is retired too, and if it was an
  // incoming upsert it was dropped and is never written at all. `rekey` is kept collapsed as the
  // contests happen, so no target of it is ever also a key and a single hop is exhaustive.
  //
  // The reference repointing below works off `rekey`, so it was always correct. What was not is a
  // caller building SQL straight from `winnerId` — `applyPlan`'s ledger repoint for a retired
  // account, or the wholesale paths' tag-edge repoint (issue #538). Naming a row that does not
  // exist trips the foreign key, and that aborts the whole atomic apply rather than one statement.
  for (let i = firstVerdict; i < collisions.length; i += 1) {
    const verdict = collisions[i]!;
    const winnerId = rekey.get(verdict.winnerId);
    if (winnerId !== undefined) collisions[i] = { ...verdict, winnerId };
  }

  return rekey;
}

/**
 * Repoint every row that referenced a retired id at its winner. Pending upserts are rewritten
 * in place; a *stored* local row that referenced the loser is re-emitted as an upsert, because
 * the loser's DELETE cascades it away and only a re-insert (against the winner) preserves it.
 */
function repointReferences(
  spec: UniqueKeySpec,
  local: LocalTables,
  localUpserts: TableRow[],
  rekey: ReadonlyMap<string, string>,
): void {
  for (const ref of spec.references) {
    const upsertedIds = new Set<string>();
    for (let i = 0; i < localUpserts.length; i += 1) {
      const u = localUpserts[i]!;
      if (u.table !== ref.table) continue;
      upsertedIds.add(String(u.row.id));
      const winner = rekey.get(String(u.row[ref.column] ?? ''));
      if (winner !== undefined) {
        localUpserts[i] = { table: ref.table, row: { ...u.row, [ref.column]: winner } };
      }
    }

    for (const row of local.tables[ref.table] ?? []) {
      if (upsertedIds.has(String(row.id))) continue; // the rewritten upsert above carries it
      const winner = rekey.get(String(row[ref.column] ?? ''));
      if (winner === undefined) continue;
      localUpserts.push({ table: ref.table, row: { ...row, [ref.column]: winner } });
    }
  }
}
