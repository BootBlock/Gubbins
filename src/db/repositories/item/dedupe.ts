/**
 * Deduplication — finding items that are the same thing, and merging one into another
 * (issue #99).
 *
 * **Nothing here runs on its own.** Both methods are invoked only by the Deduplicate-items tool
 * a user opens from Settings, and {@link ItemDedupeRepository.mergeItems} only ever acts on the
 * exact pair the user chose. A scan is a proposal; the merge is the user's decision.
 *
 * ### Scanning
 *
 * {@link ItemDedupeRepository.findDuplicates} reads the candidate columns of the active items
 * and hands them to the pure `features/inventory/dedupe/duplicate-groups` seam, which does all
 * the judging. The read is deliberately whole-table rather than a `GROUP BY … HAVING COUNT(*) > 1`
 * that would return only the duplicates:
 *
 * - The name signal folds through `lib/name-fold`, and **SQLite's `LOWER`/`NOCASE` folds ASCII
 *   A–Z and nothing else** (see `db/repositories/name-lookup` for why widening it is not
 *   available on any driver this app runs on). A SQL grouping would silently miss every
 *   duplicate that differs by an accented character or a `ß`, which is exactly the near-duplicate
 *   nobody can see.
 * - The fuzzy signal has to compare names that share no key at all, so it needs every name
 *   regardless.
 *
 * The honest cost is that the scan is bounded: at most {@link DEDUPE_SCAN_LIMIT} items are read,
 * and the result says how many were examined out of how many exist so a truncated scan cannot be
 * mistaken for a clean bill of health. If that limit ever becomes the binding constraint, the
 * lever is a stored fold column with its own index — the shape `suppliers.name_key` already has —
 * not a narrower fold here.
 *
 * ### Merging
 *
 * A merge **re-points what refers to the removed item, then marks that item as removed** — the
 * same soft delete the ordinary Delete action performs, in the same transaction as the re-point.
 * It is deliberately not a hard delete:
 *
 * - A hard delete would cascade the removed item's Activity Log and stock ledger away, and both
 *   are append-only, union-by-id synced records that no peer would ever restore.
 * - Tombstones expire (§7.6). A peer offline longer than the tombstone's life would resurrect a
 *   hard-deleted item, and the merge would have to be done again. A soft delete is a plain
 *   last-write-wins field, so it converges whenever the peer next syncs.
 * - It stays **undoable**: `restore` brings the item back, with its history and its stock intact.
 *   The re-point does not undo with it, which the tool says plainly before the user commits.
 *
 * The removed item keeps its own attributes — its stock, tags, images, custom fields, aliases and
 * ledger travel with it into the removed state, exactly as they do for any deleted item. What
 * moves is the set of things **elsewhere** that name it: see {@link ITEM_REFERENCE_SPECS}.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import {
  findDuplicateGroups,
  type DuplicateGroup,
  type DuplicateScanOptions,
} from '@/features/inventory/dedupe/duplicate-groups';
import {
  planKitEdgeRemap,
  planRelationRemap,
  type ItemRelationEdge,
  type KitComponentEdge,
} from '@/features/inventory/dedupe/reference-remap';
import { escapeLike } from '../like';
import { foldName } from '@/lib/name-fold';
import { similarity } from '@/lib/fuzzy';
import { historyStatement } from './history';
import { tombstoneStatement } from '../tombstone';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/**
 * The most items one scan reads. Generous enough that an ordinary inventory is covered whole,
 * and low enough that the tool cannot pull an unbounded result across the worker bridge. A scan
 * that hits it reports `truncated`, so the UI can say what was and was not examined.
 */
export const DEDUPE_SCAN_LIMIT = 50_000;

/**
 * Everything **outside** an item that names it by id, and which a merge therefore re-points.
 *
 * This is the single list: the per-kind counts the tool shows are built from it, and
 * {@link ItemDedupeRepository.mergeItems} returns one figure per `kind`. Two things stop a kind
 * added here from being silently skipped: {@link REFERENCE_REMAP_STRATEGY} is an exhaustive
 * `Record<ItemReferenceKind, …>`, so a new kind fails to compile until the merge says how it
 * moves; and `ItemRepository.dedupe.test.ts` asserts that every kind's count reaches zero on the
 * removed item after a re-point, so a kind declared `'bespoke'` and then not written fails that
 * test rather than quietly leaving references behind.
 *
 * Deliberately **not** here are the removed item's *own* attributes — its stock placements, tags,
 * regions, images, attachments, aliases, capabilities, custom-field values and Activity Log.
 * Those are not references to the item, they are the item, and they stay with it in exactly the
 * state an ordinary delete would leave them.
 *
 * The `table` and `columns` strings are literals written here, never user input; they are
 * spliced into SQL rather than bound because an identifier cannot be a parameter.
 */
export const ITEM_REFERENCE_SPECS = [
  { kind: 'checkouts', table: 'checkouts', columns: ['item_id'] },
  { kind: 'bookings', table: 'asset_bookings', columns: ['item_id'] },
  { kind: 'maintenance', table: 'maintenance_schedules', columns: ['item_id'] },
  { kind: 'projectBomLines', table: 'project_bom_lines', columns: ['item_id'] },
  { kind: 'purchaseOrderLines', table: 'purchase_order_lines', columns: ['item_id'] },
  { kind: 'testRecords', table: 'test_records', columns: ['item_id'] },
  { kind: 'revaluations', table: 'revaluations', columns: ['item_id'] },
  { kind: 'supplierParts', table: 'supplier_parts', columns: ['item_id'] },
  { kind: 'kitMemberships', table: 'kit_components', columns: ['component_item_id'] },
  { kind: 'kitContents', table: 'kit_components', columns: ['kit_item_id'] },
  { kind: 'relations', table: 'item_relations', columns: ['from_item_id', 'to_item_id'] },
  { kind: 'variants', table: 'items', columns: ['parent_id'] },
] as const satisfies readonly {
  readonly kind: string;
  readonly table: string;
  readonly columns: readonly string[];
}[];

export type ItemReferenceKind = (typeof ITEM_REFERENCE_SPECS)[number]['kind'];

/** How many rows of each kind name one item. Every kind is present, `0` included. */
export type ItemReferenceCounts = Record<ItemReferenceKind, number>;

/** An empty tally, so a caller can total counts without special-casing an absent item. */
export function emptyItemReferenceCounts(): ItemReferenceCounts {
  return Object.fromEntries(ITEM_REFERENCE_SPECS.map((spec) => [spec.kind, 0])) as ItemReferenceCounts;
}

/** How many references an item carries in total. */
export function totalItemReferences(counts: ItemReferenceCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/** One item as the duplicate scan reads it: the signal columns plus what the tool displays. */
export interface DuplicateScanItem {
  readonly id: string;
  readonly name: string;
  readonly barcode: string | null;
  readonly serialNumber: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly quantity: number;
  readonly createdAt: number;
  /** The human-facing short number, so two members sharing a name are still told apart. */
  readonly serialNo: number | null;
  readonly locationName: string | null;
}

export interface DuplicateScanResult {
  readonly groups: readonly DuplicateGroup<DuplicateScanItem>[];
  /** How many active items the scan examined. */
  readonly scanned: number;
  /** How many active items exist. Equal to `scanned` unless the scan was truncated. */
  readonly total: number;
  /** Whether {@link DEDUPE_SCAN_LIMIT} cut the scan short, leaving items unexamined. */
  readonly truncated: boolean;
}

/** How alike a stored name must be to a typed one for the Add/Edit advisory to mention it. */
export const NAME_ADVISORY_THRESHOLD = 0.85;

/** The most rows the Add/Edit name advisory reads, so a common prefix cannot pull the table. */
export const NAME_ADVISORY_LIMIT = 200;

/** An item whose name a typed one matches or nearly matches. */
export interface NameMatch {
  readonly id: string;
  readonly name: string;
  readonly serialNo: number | null;
  /** `true` when the two names fold to one key — they differ only by case, spacing or composition. */
  readonly exact: boolean;
}

export interface MergeItemsInput {
  /** The item that survives. */
  readonly keepId: string;
  /** The item that is marked as removed. */
  readonly removeId: string;
  /**
   * Re-point everything naming `removeId` at `keepId`. When `false` the references are left
   * alone and only the removal happens, which is what a user wants when the two records
   * genuinely describe different things that merely look alike.
   */
  readonly remapReferences: boolean;
}

export interface MergeItemsResult {
  readonly keepId: string;
  readonly removeId: string;
  /** Per kind, how many rows were moved onto the kept item. */
  readonly remapped: ItemReferenceCounts;
  /**
   * Per kind, how many rows the merge had to drop because folding the two items onto one made
   * them impossible — a kit that would contain itself, a relation between an item and itself, a
   * link the kept item already had. Every one of these is a real loss and the tool reports it.
   */
  readonly discarded: ItemReferenceCounts;
  /**
   * How many of the removed item's supplier parts lost their *preferred* or *price source* flag
   * because the kept item already had one. The part itself moves; only the flag is cleared.
   */
  readonly demotedSupplierFlags: number;
}

interface ScanRow {
  readonly id: string;
  readonly name: string;
  readonly barcode: string | null;
  readonly serial_number: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly quantity: number;
  readonly created_at: number;
  readonly serial_no: number | null;
  readonly location_name: string | null;
}

export function withDedupe<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemDedupeRepository extends Base {
    /**
     * Find groups of active items that look like the same thing, under the caller's choice of
     * signals. Read-only, and ungated like every other read in this layer — the permission
     * boundary sits on the writes.
     *
     * Bounded by {@link DEDUPE_SCAN_LIMIT}: the oldest items are scanned first, so a truncated
     * scan covers the records that have had longest to accumulate duplicates. `truncated` says
     * when that happened.
     */
    async findDuplicates(options: DuplicateScanOptions): Promise<DuplicateScanResult> {
      const totalRow = await this.driver.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM items WHERE is_active = 1;',
      );
      const total = totalRow?.n ?? 0;

      const rows = await this.driver.query<ScanRow>(
        `SELECT i.id, i.name, i.barcode, i.serial_number, i.mpn, i.manufacturer,
                i.quantity, i.created_at, i.serial_no, l.name AS location_name
         FROM items i
         LEFT JOIN locations l ON l.id = i.location_id
         WHERE i.is_active = 1
         ORDER BY i.created_at ASC, i.id ASC
         LIMIT ?;`,
        [DEDUPE_SCAN_LIMIT],
      );

      const items: DuplicateScanItem[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        barcode: row.barcode,
        serialNumber: row.serial_number,
        mpn: row.mpn,
        manufacturer: row.manufacturer,
        quantity: row.quantity,
        createdAt: row.created_at,
        serialNo: row.serial_no,
        locationName: row.location_name,
      }));

      return {
        groups: findDuplicateGroups(items, options),
        scanned: items.length,
        total,
        truncated: items.length < total,
      };
    }

    /**
     * Active items whose name matches, or nearly matches, `name` — what the Add/Edit item
     * dialog's duplicate-name advisory is judged from (issue #99).
     *
     * Two narrowings, both index-friendly, because this runs while a user is filling a form:
     * the folded-exact equality, and a **two-character prefix** on `items.name`, which
     * `idx_items_name` can seek and which `LIKE`'s default ASCII case-insensitivity makes
     * case-agnostic. The rows that come back are then judged in JS by `foldName` (exact) and
     * `lib/fuzzy`'s `similarity` (near), so the verdict agrees with the deduplication tool's.
     *
     * The honest limit: a stored name that differs from the typed one *only* by a non-ASCII case
     * fold within its first two characters — `Ärmel` typed against a stored `ärmel` — is not
     * narrowed to and so is not reported. This is an advisory, not a uniqueness rule (item names
     * are deliberately not unique), and the deduplication tool is the exhaustive pass; widening
     * the narrowing here would mean the unindexable `GLOB` scan `name-lookup` documents, on every
     * keystroke-settled field.
     */
    async findSimilarlyNamed(name: string): Promise<NameMatch[]> {
      const folded = foldName(name);
      if (folded.length < 2) return [];

      const rows = await this.driver.query<{ id: string; name: string; serial_no: number | null }>(
        `SELECT id, name, serial_no FROM items
         WHERE is_active = 1
           AND (LOWER(TRIM(name)) = ? OR name LIKE ? ESCAPE '\\')
         -- Exact folded matches first, so the row this is really asking about cannot be cut by
         -- the LIMIT: a prefix as short as two characters can easily have 200 rows sorting ahead
         -- of it, and losing the exact one is the whole point of the read.
         ORDER BY (LOWER(TRIM(name)) = ?) DESC, name COLLATE NOCASE ASC, id ASC
         LIMIT ?;`,
        [folded, `${escapeLike(name.trim().slice(0, 2))}%`, folded, NAME_ADVISORY_LIMIT],
      );

      const matches: NameMatch[] = [];
      for (const row of rows) {
        const other = foldName(row.name);
        const exact = other === folded;
        if (!exact && similarity(folded, other) < NAME_ADVISORY_THRESHOLD) continue;
        matches.push({ id: row.id, name: row.name, serialNo: row.serial_no, exact });
      }
      // Exact matches first: they are the ones the user almost certainly did not mean to create.
      return matches.sort((a, b) => Number(b.exact) - Number(a.exact));
    }

    /**
     * How many rows of each {@link ITEM_REFERENCE_SPECS} kind name each of `itemIds`.
     *
     * One round-trip per kind rather than per item: the tool shows the tally for every member of
     * a duplicate group at once, and a per-item read would be N+1 over a list the user is about
     * to act on. Ids not present in the database simply come back as an all-zero tally.
     */
    async countItemReferences(itemIds: readonly string[]): Promise<Map<string, ItemReferenceCounts>> {
      const counts = new Map<string, ItemReferenceCounts>();
      const unique = [...new Set(itemIds)];
      if (unique.length === 0) return counts;
      for (const id of unique) counts.set(id, emptyItemReferenceCounts());

      const placeholders = unique.map(() => '?').join(', ');
      for (const spec of ITEM_REFERENCE_SPECS) {
        // A kind with two columns (a relation names an item at either end) tallies both, and a
        // schema CHECK stops the two ever being the same item, so no row is counted twice.
        for (const column of spec.columns) {
          const rows = await this.driver.query<{ owner: string; n: number }>(
            `SELECT ${column} AS owner, COUNT(*) AS n FROM ${spec.table}
             WHERE ${column} IN (${placeholders})
             GROUP BY ${column};`,
            [...unique],
          );
          for (const row of rows) {
            const tally = counts.get(row.owner);
            if (tally) counts.set(row.owner, { ...tally, [spec.kind]: tally[spec.kind] + row.n });
          }
        }
      }
      return counts;
    }

    /**
     * Merge `removeId` into `keepId`: re-point what refers to the removed item (when asked), then
     * mark it as removed. One transaction, so a merge is all-or-nothing and can never leave half
     * the references moved.
     *
     * Gated on both `items:write` (the re-point edits other rows) and `items:delete` (an item
     * leaves active inventory). **Allowed while storage is locked**, exactly as `softDelete` is:
     * a Hard Stop is when a user most needs to fold duplicate records together, and the merge
     * removes far more rows from the active set than the two ledger entries it adds.
     *
     * Undo is `restore(removeId)`, which brings the item back with its stock and history intact.
     * The re-point is **not** undone by it — the tool says so before the user commits.
     */
    async mergeItems(input: MergeItemsInput): Promise<MergeItemsResult> {
      this.assertPermission('items:write');
      this.assertPermission('items:delete');

      const { keepId, removeId, remapReferences } = input;
      if (keepId === removeId) {
        throw new DbError('SQLITE_CONSTRAINT', 'An item cannot be merged into itself.');
      }
      const keep = await this.require(keepId);
      const remove = await this.require(removeId);

      const remapped = emptyItemReferenceCounts();
      const discarded = emptyItemReferenceCounts();
      const statements: SqlStatement[] = [];
      let demotedSupplierFlags = 0;

      if (remapReferences) {
        const before = (await this.countItemReferences([removeId])).get(removeId)!;

        // --- The plain kinds: one column, no constraint that two rows can collide on. ---
        for (const spec of ITEM_REFERENCE_SPECS) {
          if (REFERENCE_REMAP_STRATEGY[spec.kind] !== 'plain') continue;
          if (before[spec.kind] === 0) continue;
          statements.push({
            sql: `UPDATE ${spec.table} SET item_id = ? WHERE item_id = ?;`,
            params: [keepId, removeId],
          });
          remapped[spec.kind] = before[spec.kind];
        }

        // --- Supplier parts: two partial UNIQUE indexes allow one preferred and one price
        // source per item, so a flag the kept item already holds is cleared before the move
        // rather than aborting the whole merge on the index. ---
        if (before.supplierParts > 0) {
          // One literal statement rather than one per flag, so this read's shape stays visible to
          // `query-row-shape.test.ts` — an identifier spliced into SQL is a statement no automated
          // check can prepare.
          const clash = await this.driver.queryOne<{ preferred: number; price_source: number }>(
            `SELECT
               (SELECT COUNT(*) FROM supplier_parts p
                 WHERE p.item_id = ?1 AND p.is_preferred = 1
                   AND EXISTS (SELECT 1 FROM supplier_parts k
                                WHERE k.item_id = ?2 AND k.is_preferred = 1)) AS preferred,
               (SELECT COUNT(*) FROM supplier_parts p
                 WHERE p.item_id = ?1 AND p.is_price_source = 1
                   AND EXISTS (SELECT 1 FROM supplier_parts k
                                WHERE k.item_id = ?2 AND k.is_price_source = 1)) AS price_source;`,
            [removeId, keepId],
          );
          demotedSupplierFlags = (clash?.preferred ?? 0) + (clash?.price_source ?? 0);
          // The `EXISTS` guard is repeated in the writes, so each one demotes only when the kept
          // item really does already hold that flag — the read decides the tally, never the effect.
          statements.push({
            sql: `UPDATE supplier_parts SET is_preferred = 0
                  WHERE item_id = ?1 AND is_preferred = 1
                    AND EXISTS (SELECT 1 FROM supplier_parts k
                                 WHERE k.item_id = ?2 AND k.is_preferred = 1);`,
            params: [removeId, keepId],
          });
          statements.push({
            sql: `UPDATE supplier_parts SET is_price_source = 0
                  WHERE item_id = ?1 AND is_price_source = 1
                    AND EXISTS (SELECT 1 FROM supplier_parts k
                                 WHERE k.item_id = ?2 AND k.is_price_source = 1);`,
            params: [removeId, keepId],
          });
          statements.push({
            sql: 'UPDATE supplier_parts SET item_id = ? WHERE item_id = ?;',
            params: [keepId, removeId],
          });
          remapped.supplierParts = before.supplierParts;
        }

        // --- Kit edges: the pure planner decides which survive, judging duplicates, self
        // containment and containment cycles against the whole graph. ---
        if (before.kitMemberships > 0 || before.kitContents > 0) {
          const edgeRows = await this.driver.query<{
            id: string;
            kit_item_id: string;
            component_item_id: string;
          }>('SELECT id, kit_item_id, component_item_id FROM kit_components;');
          const edges: KitComponentEdge[] = edgeRows.map((row) => ({
            id: row.id,
            kitItemId: row.kit_item_id,
            componentItemId: row.component_item_id,
          }));
          const plan = planKitEdgeRemap(edges, removeId, keepId);
          for (const edge of plan.remapped) {
            statements.push({
              sql: 'UPDATE kit_components SET kit_item_id = ?, component_item_id = ? WHERE id = ?;',
              params: [edge.kitItemId, edge.componentItemId, edge.id],
            });
          }
          for (const id of plan.dropped) {
            statements.push({ sql: 'DELETE FROM kit_components WHERE id = ?;', params: [id] });
            statements.push(tombstoneStatement('kit_components', id));
          }
          // Attribute each edge to the kind it was counted under, so the two tallies describe
          // the same rows the counts did.
          const byId = new Map(edges.map((e) => [e.id, e]));
          const attribute = (id: string, tally: ItemReferenceCounts) => {
            const edge = byId.get(id)!;
            if (edge.componentItemId === removeId) tally.kitMemberships += 1;
            if (edge.kitItemId === removeId) tally.kitContents += 1;
          };
          for (const edge of plan.remapped) attribute(edge.id, remapped);
          for (const id of plan.dropped) attribute(id, discarded);
        }

        // --- Relations: the id is derived from the endpoints, so a moved relation is deleted
        // and re-inserted under its new key rather than updated in place. ---
        if (before.relations > 0) {
          const relationRows = await this.driver.query<{
            id: string;
            from_item_id: string;
            to_item_id: string;
            kind: string;
            note: string | null;
          }>(
            `SELECT id, from_item_id, to_item_id, kind, note FROM item_relations
             WHERE from_item_id IN (?, ?) OR to_item_id IN (?, ?);`,
            [keepId, removeId, keepId, removeId],
          );
          const relations: ItemRelationEdge[] = relationRows.map((row) => ({
            id: row.id,
            fromItemId: row.from_item_id,
            toItemId: row.to_item_id,
            kind: row.kind,
          }));
          const plan = planRelationRemap(relations, removeId, keepId);
          const noteById = new Map(relationRows.map((row) => [row.id, row.note]));
          for (const relation of plan.remapped) {
            // Insert **before** deleting: the new row carries the old one's note, and the old
            // row is the only place that note exists.
            statements.push({
              sql: `INSERT INTO item_relations (id, from_item_id, to_item_id, kind, note)
                    VALUES (?, ?, ?, ?, ?);`,
              params: [
                relation.id,
                relation.fromItemId,
                relation.toItemId,
                relation.kind,
                noteById.get(relation.oldId) ?? null,
              ],
            });
            statements.push({
              sql: 'DELETE FROM item_relations WHERE id = ?;',
              params: [relation.oldId],
            });
            statements.push(tombstoneStatement('item_relations', relation.oldId));
          }
          for (const id of plan.dropped) {
            statements.push({ sql: 'DELETE FROM item_relations WHERE id = ?;', params: [id] });
            statements.push(tombstoneStatement('item_relations', id));
          }
          remapped.relations = plan.remapped.length;
          discarded.relations = plan.dropped.length;
        }

        // --- Variants: the removed item's children are re-parented onto the kept one, each
        // recording the move in its own ledger so a child's history does not silently change
        // parent. The kept item is excluded from the move: an item cannot be its own parent. ---
        if (before.variants > 0) {
          const children = await this.driver.query<{ id: string }>(
            'SELECT id FROM items WHERE parent_id = ? AND id <> ?;',
            [removeId, keepId],
          );
          if (children.length > 0) {
            statements.push({
              sql: 'UPDATE items SET parent_id = ? WHERE parent_id = ? AND id <> ?;',
              params: [keepId, removeId, keepId],
            });
            for (const child of children) {
              statements.push(
                historyStatement(child.id, 'VARIANT_RE_PARENTED', this.actorId(), {
                  note: 'Re-parented by a merge of its parent item.',
                  metadata: { fromItemId: removeId, toItemId: keepId },
                }),
              );
            }
          }
          remapped.variants = children.length;
        }
        // The kept item's own parent may be the item being removed, which the move above
        // deliberately skipped. Inherit the removed item's parent instead of leaving the keeper
        // pointing at a removed record — unless that would make it its own parent.
        //
        // It counts toward `variants` like any other child: `before.variants` counted it, so
        // leaving it out would report a reference the tally showed and the outcome never
        // accounted for.
        if (keep.parentId === removeId) {
          const inherited = remove.parentId === keepId ? null : remove.parentId;
          statements.push({
            sql: 'UPDATE items SET parent_id = ? WHERE id = ?;',
            params: [inherited, keepId],
          });
          statements.push(
            historyStatement(keepId, 'VARIANT_RE_PARENTED', this.actorId(), {
              note: 'Re-parented because its parent item was merged into it.',
              metadata: { fromItemId: removeId, toItemId: inherited },
            }),
          );
          remapped.variants += 1;
        }
      }

      const summary = { keepId, removeId, remapped, discarded, demotedSupplierFlags };
      statements.push({ sql: 'UPDATE items SET is_active = 0 WHERE id = ?;', params: [removeId] });
      statements.push(
        historyStatement(removeId, 'MERGED', this.actorId(), {
          note: `Merged into "${keep.name}" and removed from active inventory.`,
          metadata: { mergedIntoItemId: keepId, remapped, discarded },
        }),
      );
      statements.push(
        historyStatement(keepId, 'MERGED', this.actorId(), {
          note: `"${remove.name}" was merged into this item.`,
          metadata: { mergedFromItemId: removeId, remapped, discarded },
        }),
      );

      await this.driver.transaction(statements);
      return summary;
    }
  };
}

/**
 * How each reference kind moves.
 *
 * `'plain'` is a single `UPDATE … SET item_id = ?`: one nullable-or-not column, with no unique
 * index or `CHECK` that two rows folding onto one item could violate. `'bespoke'` means the merge
 * handles it by hand above, because a plain `UPDATE` would abort the transaction on a constraint
 * or leave a derived key describing the wrong row.
 *
 * A **`Record`, not a `Set`**, and that is the whole point: adding a kind to
 * {@link ITEM_REFERENCE_SPECS} without adding it here fails to compile, so the merge cannot
 * quietly ignore a reference the tally already counts.
 */
const REFERENCE_REMAP_STRATEGY: Record<ItemReferenceKind, 'plain' | 'bespoke'> = {
  checkouts: 'plain',
  bookings: 'plain',
  maintenance: 'plain',
  projectBomLines: 'plain',
  purchaseOrderLines: 'plain',
  testRecords: 'plain',
  revaluations: 'plain',
  supplierParts: 'bespoke',
  kitMemberships: 'bespoke',
  kitContents: 'bespoke',
  relations: 'bespoke',
  variants: 'bespoke',
};
