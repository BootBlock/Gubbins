/**
 * Kits / bundles concern (Kits v1 — definition + availability; v2 — assemble / disassemble
 * stock operations; v3 — nested-kit roll-up, cascade assembly, cross-location FEFO draw and
 * gauge components).
 *
 * A kit is an item *composed of* fixed per-kit quantities of other items (a first-aid kit =
 * 2 bandages + 1 scissors + 5 plasters). This mixin owns the `kit_components` edge table:
 * listing a kit's components, adding / re-quantifying / removing an edge, and the two
 * stock-moving operations — {@link ItemKitRepository.assemble} consumes each component and
 * produces the kit; {@link ItemKitRepository.disassemble} is its inverse. Distinct from
 * variants (child SKUs of one identity) and a project BOM (transient work): a kit is a
 * reusable many-to-many item→component relationship.
 *
 * **v3** closes the three edges v2 deferred, all driven by the pure `kit-availability` seam
 * so the maths stays exhaustively unit-testable:
 *   - *Nested-kit roll-up.* A component may itself be a kit; `assemble` can **cascade** —
 *     transitively assembling any missing sub-kit in the same transaction (parent ASSEMBLED
 *     + each sub-kit ASSEMBLED + leaf CONSUMED). The pure `planAssembly` explodes the request
 *     over the acyclic containment graph, netting each item's demand against on-hand stock so a
 *     shared leaf in a diamond is split, never double-drawn.
 *   - *Cross-location draw.* Every component is consumed **first-expiry-first-out across all of
 *     its placements** (`planItemConsumption`), not just its home location, so the buildable
 *     ceiling (grand-total stock) and the actual draw always agree. The produced kit lands at a
 *     caller-chosen destination location (defaulting to the kit's home).
 *   - *Gauge components.* A `CONSUMABLE_GAUGE` component contributes a per-kit **net-value** draw
 *     (e.g. 50 ml of adhesive); its coverage is the same `floor(stock / qty)` ratio a discrete
 *     component uses, applied to its net value.
 *
 * Stock only ever moves through the per-location / batch ledger (`item_stock` / `stock_batches`)
 * or a gauge's `current_net_value` — never `items.quantity` directly — and the whole build is one
 * atomic transaction logged to the immutable Activity Log, so a partial build can never leave the
 * ledger inconsistent.
 *
 * The containment graph must stay acyclic (a kit cannot contain itself, directly or transitively);
 * the trivial one-hop case is a DB CHECK, deeper cycles are rejected here by walking the proposed
 * component's descendant set and letting the pure `validateKitLink` decide. That guard is a read-then-write
 * check across sibling rows, so it holds on one device only — a sync merge can still close the
 * graph into a loop, which `reconcile` repairs post-merge and {@link readKitGraph} tolerates
 * (issue #539).
 */
import { DbError } from '../../errors';
import { kitRejectionMessage, validateKitLink } from '@/features/inventory/kits';
import {
  buildableCount,
  planAssembly,
  rollUpBuildable,
  type KitTreeNode,
  type RollUpResult,
} from '@/features/inventory/kit-availability';
import { DEFAULT_BATCH_KEY, planItemConsumption, type LocatedBatchLine } from '@/features/inventory/batches';
import { clampNetValue } from '../gauge';
import { tombstoneStatement } from '../tombstone';
import type { TrackingMode } from '../constants';
import type { IDatabaseDriver, SqlStatement } from '../../rpc/driver';
import type { Item } from '../types';
import {
  UNTRACKED_BATCH,
  addBatchStatement,
  itemConsumeStatements,
  placementDeltaStatements,
  runStockDraw,
  readItemBatches,
  stockBatchRowId,
} from '../stock-batches';
import { gaugeAfterDelta, gaugeDeltaHistoryStatement, gaugeValueUpdate, historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

/** One component line of a kit, joined to the component item's name, stock and tracking mode. */
export interface KitComponent {
  /** The `kit_components` row id (the stable handle for update/remove). */
  readonly id: string;
  /** The component item's id. */
  readonly componentItemId: string;
  /** The component item's name (for display). */
  readonly name: string;
  /** Units of this component consumed per whole kit (≥ 1) — a net-value draw for a gauge. */
  readonly quantity: number;
  /**
   * The component's current on-hand supply: a DISCRETE item's grand-total quantity, or a
   * CONSUMABLE_GAUGE's current net value (its `items.quantity` is meaningless). The buildable
   * count is `floor(stock / quantity)` over these.
   */
  readonly stock: number;
  /** The component item's tracking mode — DISCRETE draws by count, CONSUMABLE_GAUGE by net value. */
  readonly trackingMode: TrackingMode;
  /** Manual ordering within the kit. */
  readonly sort: number;
}

interface KitComponentRow {
  readonly id: string;
  readonly component_item_id: string;
  readonly name: string;
  readonly quantity: number;
  readonly stock: number;
  readonly tracking_mode: TrackingMode;
  readonly sort: number;
}

/** Options for {@link ItemKitRepository.assemble} (Kits v3). */
export interface AssembleOptions {
  /** Where to place the produced kit; defaults to the kit item's own primary location. */
  readonly destinationLocationId?: string;
  /** When true, transitively assemble any sub-kit short on hand in the same transaction. */
  readonly cascade?: boolean;
}

/** Per-item facts the assembly ledger and validation need, gathered once from the kit graph. */
interface ItemMeta {
  readonly name: string;
  readonly trackingMode: TrackingMode;
  readonly locationId: string;
  /** On-hand supply: DISCRETE grand-total quantity, or a gauge's current net value. */
  readonly stock: number;
  readonly grossCapacity: number | null;
  /** True when the item is itself a kit (has ≥ 1 component) — i.e. a producible sub-kit. */
  readonly hasComponents: boolean;
}

export function withKits<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemKitRepository extends Base {
    /**
     * A kit's component lines, each joined to the component item's name, current on-hand supply
     * and tracking mode. A DISCRETE component reports its grand-total quantity; a gauge reports
     * its net value (its quantity is meaningless). Ordered by the manual `sort` then name. The
     * buildable count derives from these via the pure `buildableCount`, so this stays a read.
     */
    async listKitComponents(kitId: string): Promise<KitComponent[]> {
      const rows = await this.driver.query<KitComponentRow>(
        `SELECT kc.id, kc.component_item_id, kc.quantity, kc.sort, i.name, i.tracking_mode,
                CASE WHEN i.tracking_mode = 'CONSUMABLE_GAUGE' THEN COALESCE(i.current_net_value, 0)
                     ELSE i.quantity END AS stock
         FROM kit_components kc
         JOIN items i ON i.id = kc.component_item_id
         WHERE kc.kit_item_id = ?
         ORDER BY kc.sort ASC, i.name COLLATE NOCASE ASC;`,
        [kitId],
      );
      return rows.map((r) => ({
        id: r.id,
        componentItemId: r.component_item_id,
        name: r.name,
        quantity: Number(r.quantity),
        stock: Number(r.stock),
        trackingMode: r.tracking_mode,
        sort: Number(r.sort),
      }));
    }

    /**
     * The nested-kit **roll-up** availability (Kits v3): how many whole kits are assemblable once
     * sub-kits are built on demand from deeper stock, and the deepest leaves that pin it. Walks the
     * full containment graph via {@link readKitGraph} and defers the maths to the pure
     * {@link rollUpBuildable}. `subKitCount` is how many direct components are themselves sub-kits,
     * so the UI can surface an "includes N buildable sub-kits" line only where nesting exists.
     */
    async rollUpAvailability(kitId: string): Promise<RollUpResult> {
      const { tree } = await this.readKitGraph(kitId);
      return rollUpBuildable(tree);
    }

    /**
     * Add a component to a kit (Kits v1). The quantity is the per-kit requirement (≥ 1).
     * Both items must exist; the link must not be self-containment or form a cycle (the
     * kit already sitting somewhere in the component's own sub-tree) — checked against the
     * component's descendant set via a recursive CTE. The new row's `sort` appends it to
     * the end. Write-gated. Returns the refreshed component list.
     */
    async addKitComponent(kitId: string, componentItemId: string, quantity: number): Promise<KitComponent[]> {
      this.assertPermission('items:write');
      this.assertWritable();
      const qty = Math.max(1, Math.floor(quantity));
      await this.assertKitLinkValid(kitId, componentItemId);

      await this.driver.execute(
        `INSERT INTO kit_components (id, kit_item_id, component_item_id, quantity, sort)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort) + 1, 0) FROM kit_components WHERE kit_item_id = ?));`,
        [crypto.randomUUID(), kitId, componentItemId, qty, kitId],
      );
      return this.listKitComponents(kitId);
    }

    /**
     * Change a component line's per-kit quantity (≥ 1). Write-gated. Returns the refreshed
     * component list for the owning kit.
     */
    async updateKitComponentQty(id: string, quantity: number): Promise<KitComponent[]> {
      this.assertPermission('items:write');
      this.assertWritable();
      const qty = Math.max(1, Math.floor(quantity));
      const row = await this.driver.queryOne<{ kit_item_id: string }>(
        'SELECT kit_item_id FROM kit_components WHERE id = ?;',
        [id],
      );
      if (!row) {
        throw new DbError('SQLITE_CONSTRAINT', `Kit component "${id}" does not exist.`);
      }
      await this.driver.execute('UPDATE kit_components SET quantity = ? WHERE id = ?;', [qty, id]);
      return this.listKitComponents(row.kit_item_id);
    }

    /**
     * Remove a component line from its kit. Write-gated (a definition edit). The DELETE and its
     * tombstone go in the *same* transaction so the removal propagates on the next sync rather
     * than being mistaken for an edge the peer should re-download (§7.2, issue #151). A missing
     * id is a genuine no-op: no tombstone is recorded, since tombstoning an id this device never
     * held would wrongly instruct peers to delete it. Returns the refreshed component list.
     */
    async removeKitComponent(id: string): Promise<KitComponent[]> {
      this.assertPermission('items:write');
      this.assertWritable();
      const row = await this.driver.queryOne<{ kit_item_id: string }>(
        'SELECT kit_item_id FROM kit_components WHERE id = ?;',
        [id],
      );
      if (!row) return [];
      await this.driver.transaction([
        { sql: 'DELETE FROM kit_components WHERE id = ?;', params: [id] },
        tombstoneStatement('kit_components', id),
      ]);
      return this.listKitComponents(row.kit_item_id);
    }

    /**
     * Assemble `count` whole kits from their components (Kits v2, extended in v3). In one atomic
     * transaction each component's stock is drawn down and the kit item's stock grown, with a
     * reciprocal `CONSUMED` (or `GAUGE_UPDATE` for a gauge) entry per component and an `ASSEMBLED`
     * entry on the kit — so the immutable ledger records the whole build and can never drift.
     *
     * All-or-nothing: rejected outright unless the request is buildable, validated up-front by the
     * pure {@link planAssembly}. Each DISCRETE component is drawn first-expiry-first-out **across
     * every location it holds stock in** (v3), a gauge component by a net-value decrement, and the
     * kit is produced at `options.destinationLocationId` (defaulting to its home). With
     * `options.cascade` on, any sub-kit short on hand is transitively assembled first (its own
     * components consumed, one `ASSEMBLED` entry each) — the plan nets shared leaves so a diamond
     * is never over-drawn. Write-gated. Returns the updated kit.
     */
    async assemble(kitId: string, count: number, options: AssembleOptions = {}): Promise<Item> {
      this.assertPermission('items:write');
      this.assertPermission('stock:write');
      this.assertWritable();
      const n = assertWholeCount(count, 'assemble');
      const kit = await this.require(kitId);
      assertDiscreteKit(kit);
      const cascade = options.cascade ?? false;

      const { tree, meta } = await this.readKitGraph(kitId);
      if (tree.components.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'This kit has no components to assemble.');
      }
      assertAssemblableComponents(kitId, meta);

      const plan = planAssembly(tree, n, cascade);
      if (!plan.feasible) {
        const ceiling = cascade
          ? rollUpBuildable(tree).count
          : buildableCount(tree.components.map((c) => ({ quantity: c.quantity, stock: c.node.stock }))).count;
        const short = plan.shortfalls.map((s) => s.name).join(', ');
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough stock to assemble ${n} ${plural(n, 'kit')}: at most ${ceiling} buildable` +
            (short ? ` (short on ${short}).` : '.'),
        );
      }

      const destination = await this.resolveDestination(options.destinationLocationId, kit.locationId);
      // A live in-transaction ledger: because a cascade produces a sub-kit and then consumes it
      // (and a diamond consumes a shared leaf from two steps), each draw must be planned against
      // the running state, not a stale snapshot — so the emitted statements stay consistent when
      // they execute in order.
      const ledger = new AssemblyLedger(meta);
      await ledger.preload(this.driver);

      const statements: SqlStatement[] = [];
      for (const step of plan.steps) {
        for (const draw of step.draws) {
          const m = meta.get(draw.itemId)!;
          statements.push(...ledger.consume(draw.itemId, draw.quantity));
          statements.push(
            historyStatement(
              draw.itemId,
              m.trackingMode === 'CONSUMABLE_GAUGE' ? 'GAUGE_UPDATE' : 'CONSUMED',
              this.actorId(),
              {
                ...(m.trackingMode === 'CONSUMABLE_GAUGE'
                  ? { netValueDelta: -draw.quantity }
                  : { quantityDelta: -draw.quantity }),
                note: `Consumed ${draw.quantity} assembling ${step.buildQty} × "${step.name}".`,
                metadata: { kitId: step.itemId, count: step.buildQty, quantity: draw.quantity },
              },
            ),
          );
        }
        const produceLocation = step.itemId === kitId ? destination : meta.get(step.itemId)!.locationId;
        statements.push(
          ...ledger.produce(step.itemId, produceLocation, step.buildQty),
          historyStatement(step.itemId, 'ASSEMBLED', this.actorId(), {
            quantityDelta: step.buildQty,
            note:
              step.itemId === kitId
                ? `Assembled ${step.buildQty} ${plural(step.buildQty, 'kit')} from components.`
                : `Assembled ${step.buildQty} × "${step.name}" as a sub-kit.`,
            metadata: {
              count: step.buildQty,
              components: step.draws.map((d) => ({ id: d.itemId, quantity: d.quantity })),
            },
          }),
        );
      }
      await runStockDraw(this.driver, statements);
      return (await this.getById(kitId))!;
    }

    /**
     * Break `count` whole kits back down into their direct components (Kits v2, extended in v3) —
     * the inverse of a single-level {@link ItemKitRepository.assemble}. The kit is drawn down by
     * `count` **first-expiry-first-out across every location it sits in** (v3), and each component
     * grown by `qtyPerKit × count`: a DISCRETE component returns to its home placement, a gauge
     * component's net value is topped back up (clamped to its capacity). Logged as a `DISASSEMBLED`
     * entry on the kit and a reciprocal `QUANTITY_CHANGE` / `GAUGE_UPDATE` per component recovered.
     * Rejected unless the kit has at least `count` on hand. Write-gated. Returns the updated kit.
     */
    async disassemble(kitId: string, count: number): Promise<Item> {
      this.assertPermission('items:write');
      this.assertPermission('stock:write');
      this.assertWritable();
      const n = assertWholeCount(count, 'disassemble');
      const kit = await this.require(kitId);
      assertDiscreteKit(kit);
      const components = await this.listKitComponents(kitId);
      if (components.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'This kit has no components to disassemble into.');
      }
      if (n > kit.quantity) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Not enough kits on hand to disassemble ${n}: ${kit.quantity} available.`,
        );
      }

      const meta = await this.loadItemMeta(
        components.map((c) => c.componentItemId),
        new Set(),
      );
      assertRecoverableComponents(meta);

      const statements: SqlStatement[] = [
        ...(await itemConsumeStatements(this.driver, kitId, n)),
        historyStatement(kitId, 'DISASSEMBLED', this.actorId(), {
          quantityDelta: -n,
          note: `Disassembled ${n} ${plural(n, 'kit')} back into components.`,
          metadata: {
            count: n,
            components: components.map((c) => ({ id: c.componentItemId, quantity: c.quantity * n })),
          },
        }),
      ];
      for (const c of components) {
        const give = c.quantity * n;
        const m = meta.get(c.componentItemId)!;
        if (m.trackingMode === 'CONSUMABLE_GAUGE') {
          // Relative in SQL, exactly as `adjustGauge` recovers material (issue #297): an
          // absolute write computed from `m.stock` — read before the transaction — would
          // discard any adjust that landed in between while still logging its own delta.
          // The note's figure is composed from that same pre-read, so like every ledger
          // note it narrates the event as it was requested; the stored delta is the exact one.
          // Non-null by the table CHECK: a CONSUMABLE_GAUGE row must carry a capacity > 0.
          // (A `?? 0` fallback here would silently drop the upper clamp the SQL always applies.)
          const applied = clampNetValue(m.stock + give, m.grossCapacity!) - m.stock;
          const nextValue = gaugeAfterDelta(give);
          statements.push(
            gaugeDeltaHistoryStatement(c.componentItemId, this.actorId(), nextValue, {
              note: `Recovered ${applied} from disassembling ${n} × "${kit.name}".`,
              metadata: { kitId, count: n },
            }),
            gaugeValueUpdate(c.componentItemId, nextValue),
          );
        } else {
          statements.push(
            ...(await placementDeltaStatements(this.driver, c.componentItemId, m.locationId, give)),
            historyStatement(c.componentItemId, 'QUANTITY_CHANGE', this.actorId(), {
              quantityDelta: give,
              note: `Recovered ${give} from disassembling ${n} × "${kit.name}".`,
              metadata: { kitId, count: n, quantityPerKit: c.quantity },
            }),
          );
        }
      }
      await runStockDraw(this.driver, statements);
      return (await this.getById(kitId))!;
    }

    /**
     * Build the kit containment graph rooted at `kitId` — the kit plus every item it transitively
     * contains — as a nested {@link KitTreeNode} tree (shared nodes de-duplicated so a diamond is
     * one node), paired with a per-item {@link ItemMeta} map for the ledger dispatch. Discovery
     * walks the edges level by level; the item rows are then read in one batched query.
     *
     * Termination does **not** rest on the acyclic-containment invariant: that invariant is
     * enforced per device at write time, and a sync merge can close the graph into a loop across
     * two of them (issue #539). Both the discovery walk and the tree build therefore carry their
     * own guard, so a corrupt graph yields a truncated tree rather than overflowing the stack.
     */
    private async readKitGraph(kitId: string): Promise<{ tree: KitTreeNode; meta: Map<string, ItemMeta> }> {
      const edgesById = new Map<string, { componentId: string; quantity: number }[]>();
      const kitIds = new Set<string>();
      const queue = [kitId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (edgesById.has(id)) continue;
        const edges = await this.driver.query<{ component_item_id: string; quantity: number }>(
          `SELECT component_item_id, quantity FROM kit_components WHERE kit_item_id = ?
           ORDER BY sort ASC;`,
          [id],
        );
        edgesById.set(
          id,
          edges.map((e) => ({ componentId: e.component_item_id, quantity: Number(e.quantity) })),
        );
        if (edges.length > 0) kitIds.add(id);
        for (const e of edges) queue.push(e.component_item_id);
      }

      const meta = await this.loadItemMeta([...edgesById.keys()], kitIds);
      const built = new Map<string, KitTreeNode>();
      const open = new Set<string>();
      const build = (id: string): KitTreeNode => {
        const cached = built.get(id);
        if (cached) return cached;
        const m = meta.get(id)!;
        open.add(id);
        // An edge back into an item still open further up this branch closes a containment loop.
        // The write-time validator makes that unreachable on one device, but the graph is an edge
        // table that a merge can close into a loop across two (issue #539 — repaired post-merge in
        // `reconcile`), and recursing into one would overflow the stack inside the database worker.
        // The back edge is therefore dropped outright rather than followed. It cannot instead be
        // rendered as a childless stub node: `flattenKit` keys the tree by item id, so a stub would
        // re-form the very loop this drops, and the roll-up's topological walk would then recurse
        // on it. A merged graph is repaired within the sync that produced it, so the truncated
        // sub-tree is what the kit reads as only until then.
        const components = (edgesById.get(id) ?? [])
          .filter((e) => meta.has(e.componentId) && !open.has(e.componentId))
          .map((e) => ({ quantity: e.quantity, node: build(e.componentId) }));
        open.delete(id);
        const node: KitTreeNode = { itemId: id, name: m.name, stock: m.stock, components };
        built.set(id, node);
        return node;
      };
      return { tree: build(kitId), meta };
    }

    /** Read the {@link ItemMeta} for a set of items in one batched query. */
    private async loadItemMeta(
      ids: readonly string[],
      kitIds: ReadonlySet<string>,
    ): Promise<Map<string, ItemMeta>> {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return new Map();
      const rows = await this.driver.query<{
        id: string;
        name: string;
        tracking_mode: TrackingMode;
        location_id: string;
        quantity: number;
        current_net_value: number | null;
        gross_capacity: number | null;
      }>(
        `SELECT id, name, tracking_mode, location_id, quantity, current_net_value, gross_capacity
         FROM items WHERE id IN (${unique.map(() => '?').join(', ')});`,
        [...unique],
      );
      const meta = new Map<string, ItemMeta>();
      for (const r of rows) {
        meta.set(r.id, {
          name: r.name,
          trackingMode: r.tracking_mode,
          locationId: r.location_id,
          stock:
            r.tracking_mode === 'CONSUMABLE_GAUGE' ? Number(r.current_net_value ?? 0) : Number(r.quantity),
          grossCapacity: r.gross_capacity,
          hasComponents: kitIds.has(r.id),
        });
      }
      return meta;
    }

    /** Validate a destination location exists (when the caller pins one), returning the target id. */
    private async resolveDestination(
      destinationLocationId: string | undefined,
      fallback: string,
    ): Promise<string> {
      if (!destinationLocationId) return fallback;
      const loc = await this.driver.queryOne('SELECT 1 AS ok FROM locations WHERE id = ?;', [
        destinationLocationId,
      ]);
      if (!loc) {
        throw new DbError(
          'SQLITE_CONSTRAINT_FOREIGNKEY',
          `Location "${destinationLocationId}" does not exist.`,
        );
      }
      return destinationLocationId;
    }

    /**
     * Guard a proposed `kit → component` link. Both items must exist; the link must not be
     * self-containment or close a cycle. A cycle would form if the kit is already reachable
     * *below* the proposed component in the containment graph — so walk the component's
     * descendant set (every item it transitively contains) via a recursive CTE and let the
     * pure `validateKitLink` decide. Throws a `DbError` on rejection.
     */
    private async assertKitLinkValid(kitId: string, componentItemId: string): Promise<void> {
      const kitExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [kitId]);
      if (!kitExists) {
        throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Kit item "${kitId}" does not exist.`);
      }
      const componentExists = await this.driver.queryOne('SELECT 1 AS ok FROM items WHERE id = ?;', [
        componentItemId,
      ]);
      if (!componentExists) {
        throw new DbError(
          'SQLITE_CONSTRAINT_FOREIGNKEY',
          `Component item "${componentItemId}" does not exist.`,
        );
      }

      // Every item reachable *below* the proposed component through the containment graph
      // (its components, their components, …). A cycle exists iff the kit is among them.
      // UNION (not UNION ALL) terminates even if the data somehow already held a cycle.
      const descendantRows = await this.driver.query<{ id: string }>(
        `WITH RECURSIVE descendants(id) AS (
           SELECT ?
           UNION
           SELECT kc.component_item_id FROM kit_components kc
           JOIN descendants d ON kc.kit_item_id = d.id
         )
         SELECT id FROM descendants;`,
        [componentItemId],
      );

      const rejection = validateKitLink({
        kitId,
        componentId: componentItemId,
        componentDescendantIds: descendantRows.map((r) => r.id),
      });
      if (rejection) {
        throw new DbError('SQLITE_CONSTRAINT', kitRejectionMessage(rejection));
      }
    }
  };
}

/** One mutable batch line of the in-transaction ledger (a working copy of a `stock_batches` row). */
interface MutableLine {
  readonly locationId: string;
  readonly batchKey: string;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly expiryDate: number | null;
  quantity: number;
}

/**
 * A live, in-memory projection of the batch ledger (and gauge net values) for the duration of one
 * assembly, so each draw is planned against the running state the earlier statements will have
 * produced — not a stale snapshot. This is what keeps a cascade (produce a sub-kit, then consume
 * it) and a diamond (consume a shared leaf from two steps) correct when the statements execute in
 * order. Discrete draws map to per-batch decrements; a produced item grows its home default batch;
 * a gauge draw decrements its net value.
 */
class AssemblyLedger {
  private readonly discrete = new Map<string, MutableLine[]>();
  private readonly gauge = new Map<string, number>();
  private readonly meta: Map<string, ItemMeta>;

  // NB: an explicit field + assignment, not a `private readonly meta` constructor parameter
  // property. The bridge runs this source directly under Node's strip-only TypeScript loader
  // (see bridge/loader.mjs), which rejects parameter properties — so keep this class free of them.
  constructor(meta: Map<string, ItemMeta>) {
    this.meta = meta;
  }

  /** Load each item's current batch composition (or gauge net value) into the projection. */
  async preload(driver: IDatabaseDriver): Promise<void> {
    for (const [id, m] of this.meta) {
      if (m.trackingMode === 'CONSUMABLE_GAUGE') {
        this.gauge.set(id, m.stock);
      } else {
        const rows = await readItemBatches(driver, id);
        this.discrete.set(
          id,
          rows.map((r) => ({
            locationId: r.locationId,
            batchKey: r.batchKey,
            batchNumber: r.batchNumber,
            lotNumber: r.lotNumber,
            expiryDate: r.expiryDate,
            quantity: r.quantity,
          })),
        );
      }
    }
  }

  /** Emit the statements to consume `amount` of `itemId`, updating the live projection. */
  consume(itemId: string, amount: number): SqlStatement[] {
    const m = this.meta.get(itemId)!;
    if (m.trackingMode === 'CONSUMABLE_GAUGE') {
      this.gauge.set(itemId, (this.gauge.get(itemId) ?? 0) - amount);
      return [
        {
          sql: 'UPDATE items SET current_net_value = current_net_value - ? WHERE id = ?;',
          params: [amount, itemId],
        },
      ];
    }
    const lines = this.discrete.get(itemId) ?? [];
    const plan = planItemConsumption(lines as readonly LocatedBatchLine[], amount);
    for (const c of plan.consumed) {
      const line = lines.find((l) => l.locationId === c.locationId && l.batchKey === c.batchKey);
      if (line) line.quantity -= c.amount;
    }
    return plan.consumed.map((c) => ({
      sql: 'UPDATE stock_batches SET quantity = quantity - ? WHERE id = ?;',
      params: [c.amount, stockBatchRowId(itemId, c.locationId, c.batchKey)],
    }));
  }

  /** Emit the statement to produce `amount` of `itemId` at `locationId`, updating the projection. */
  produce(itemId: string, locationId: string, amount: number): SqlStatement[] {
    const lines = this.discrete.get(itemId) ?? [];
    const existing = lines.find((l) => l.locationId === locationId && l.batchKey === DEFAULT_BATCH_KEY);
    if (existing) {
      existing.quantity += amount;
    } else {
      lines.push({
        locationId,
        batchKey: DEFAULT_BATCH_KEY,
        batchNumber: null,
        lotNumber: null,
        expiryDate: null,
        quantity: amount,
      });
    }
    this.discrete.set(itemId, lines);
    return [addBatchStatement(itemId, locationId, UNTRACKED_BATCH, amount)];
  }
}

/**
 * Validate an assemble/disassemble `count` is a whole number ≥ 1, returning the integer.
 * Rejects fractions and non-positive values with a clear constraint error rather than a raw
 * ledger `CHECK` failure downstream.
 */
function assertWholeCount(count: number, verb: 'assemble' | 'disassemble'): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new DbError('SQLITE_CONSTRAINT', `The number of kits to ${verb} must be a whole number ≥ 1.`);
  }
  return count;
}

/**
 * Guard that the kit item itself is DISCRETE before its stock is grown/shrunk by assembly —
 * a SERIALISED (quantity pinned at 1), gauge or unlimited item can't be produced/consumed by
 * count. Mirrors the `transferStock` / `adjustQuantity` DISCRETE precondition.
 */
function assertDiscreteKit(kit: Item): void {
  if (kit.trackingMode !== 'DISCRETE') {
    throw new DbError(
      'SQLITE_CONSTRAINT',
      `Only Discrete items can be assembled or disassembled as kits ("${kit.name}" is ${kit.trackingMode}).`,
    );
  }
}

/**
 * Guard every item in the assembly graph is movable by the build (Kits v3): a producible sub-kit
 * must be DISCRETE (grown/consumed by count), and a leaf component must be DISCRETE or a
 * CONSUMABLE_GAUGE (a net-value draw). A SERIALISED or UNTRACKED component can't be moved by
 * quantity — rejected here with a clear message rather than a downstream ledger `CHECK` failure.
 */
function assertAssemblableComponents(rootId: string, meta: Map<string, ItemMeta>): void {
  for (const [id, m] of meta) {
    if (id === rootId) continue;
    if (m.hasComponents) {
      if (m.trackingMode !== 'DISCRETE') {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `A sub-kit must be Discrete to assemble ("${m.name}" is ${m.trackingMode}).`,
        );
      }
    } else if (m.trackingMode !== 'DISCRETE' && m.trackingMode !== 'CONSUMABLE_GAUGE') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Kit components must be Discrete or a consumable gauge to move by quantity ("${m.name}" is ${m.trackingMode}).`,
      );
    }
  }
}

/** Guard every direct component recovered by a disassembly is DISCRETE or a CONSUMABLE_GAUGE. */
function assertRecoverableComponents(meta: Map<string, ItemMeta>): void {
  for (const m of meta.values()) {
    if (m.trackingMode !== 'DISCRETE' && m.trackingMode !== 'CONSUMABLE_GAUGE') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Kit components must be Discrete or a consumable gauge to recover by quantity ("${m.name}" is ${m.trackingMode}).`,
      );
    }
  }
}

/** Local noun pluraliser for ledger notes (kept in-layer; the UI uses `@/lib/plural`). */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
