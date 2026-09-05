/**
 * LocationRepository (spec §2.1.1, §4, §7.5.3).
 *
 * Encapsulates all SQL for the infinitely nested, self-referential locations
 * hierarchy. Enforces the invariants the schema cannot express alone: the
 * system-locked Unassigned location is immutable; parent moves are cycle-checked
 * with a recursive CTE; and deleting a location re-parents its orphaned items to
 * Unassigned (§4) while promoting its child locations, recording the moves in the
 * immutable Activity Log.
 */
import { DbError } from '../errors';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { assertTextLimit } from './text-limits';
import type { SqlStatement } from '../rpc/driver';
import { historyStatement } from './item/history';
import { BaseRepository } from './base';
import { planCheckInAllForTarget } from './checkout-plan';
import { markCountedStatement } from './location-count';
import { withRecomputeDeferred } from './stock';
import { locationHistoryStatement, type LocationHistoryFields } from './location-history';
import { UNASSIGNED_LOCATION_ID, clampDeadStockDays, type LocationHistoryAction } from './constants';
import { rowToLocation, rowToLocationHistoryEntry } from './mappers';
import { parseLocationBranch } from '@/features/inventory/location-path';
import { PACKING_FACTOR_BOUNDS, rawContainerVolume } from '@/lib/volume';
import { tombstoneStatement } from './tombstone';
import type {
  CreateLocationInput,
  Location,
  LocationHistoryEntry,
  LocationHistoryWithActorRow,
  LocationRow,
  LocationTreeNode,
  LocationVolumeTotals,
  LocationWithCount,
  Page,
  PageParams,
  UpdateLocationInput,
} from './types';

/**
 * Filters for the cross-location activity feed (issue #693) — the mirror of the item feed's
 * `ActivityFeedFilters`, over the much smaller {@link LOCATION_HISTORY_ACTIONS} vocabulary.
 */
export interface LocationHistoryFeedFilters extends PageParams {
  /**
   * Restrict the feed to these actions. Omitted (`undefined`) = the full feed, so the common
   * "show everything" case never builds an `IN (…)`; an **explicit empty array** matches nothing,
   * so de-selecting every filter chip shows an empty feed rather than silently falling back to
   * everything. The same unambiguous sentinel the item feed uses.
   */
  readonly actions?: readonly LocationHistoryAction[];
}

/**
 * The action predicate shared by the location activity feed and its count, so the two can never
 * drift apart and start disagreeing about how many rows the filter matches. The unfiltered feed
 * (`undefined`, the common case) yields the always-true `1` rather than dropping the `WHERE`
 * altogether: that keeps both callers' SQL a template whose interpolated span is a valid
 * sub-expression, which is what lets `query-row-shape.test.ts` actually prepare them and check
 * their projections instead of writing them off as unverifiable.
 *
 * Callers handle the explicit-empty-array case before reaching here — it means "match nothing",
 * which is an early return rather than a clause.
 *
 * `prefix` qualifies the column for the caller that reads through a table alias (the feed, which
 * joins `users` for the actor's name); the count has no join and passes none.
 */
function locationHistoryActionFilter(
  actions: readonly LocationHistoryAction[] | undefined,
  prefix = '',
): string {
  return actions && actions.length > 0 ? `${prefix}action IN (${actions.map(() => '?').join(', ')})` : '1';
}

interface LocationCountRow extends LocationRow {
  readonly item_count: number;
}

/**
 * One group of {@link VOLUME_TOTALS_SQL} — a location's aggregated stock volume.
 *
 * The sums are nullable because SQLite's `SUM` returns NULL over no rows, and because the
 * `w·h·d` product is NULL for an item missing any dimension. Both mean "nothing to add", so the
 * mapper coalesces to zero.
 */
interface LocationVolumeTotalsRow {
  readonly location_id: string;
  readonly used_volume: number | null;
  readonly measured_units: number | null;
  readonly total_units: number | null;
  readonly measured_items: number | null;
  readonly total_items: number | null;
}

/** Options shared by the three location reads ({@link LocationRepository.list}, `listAll`, `getTree`). */
export interface LocationReadOptions {
  /**
   * Also aggregate the per-location stock volume totals (issue #457) that the cube-utilisation
   * fill bar needs. **Off by default, and deliberately so** (issue #525): the aggregate walks the
   * `item_stock` ledger, so it costs O(stock), not O(locations) — while the great majority of
   * callers (every picker's name lookup, the bridge's id→name map, the export walk) want the
   * location rows and nothing else. Ask for it only where a fullness bar is actually rendered.
   */
  readonly withVolume?: boolean;
}

/**
 * Every location with its live (active) item count (issue #167).
 *
 * The count comes from the trigger-maintained `location_item_counts` cache rather than an
 * aggregate over `items`. The obvious spelling — `LEFT JOIN items … GROUP BY l.id` — scans the
 * whole items table, and since most item writes invalidate the sidebar tree that scan ran on
 * every create, move and delete. Reading the counter makes it a bounded join over the location
 * hierarchy instead, independent of how many items exist.
 *
 * `COALESCE` covers a location with no counter row: the cache only gains one when a location
 * first holds an item, so "no row" and "zero" are the same statement.
 *
 * The volume totals (issue #457) are an aggregate over the per-location `item_stock` ledger
 * joined to `items` — the "supply" side of cube utilisation, measuring the stock that physically
 * occupies space *here*. It groups by `item_stock.location_id` (the placement) and reads the
 * ledger quantity, never `items.quantity` (the grand total spread across every placement), so
 * stock split across drawers is measured where it actually sits. `used_volume` sums `w·h·d·qty`
 * only for fully-measured items — SQLite's `SUM` skips the NULL product of an item missing any
 * dimension — while the measured/total unit split (needed for the honest coverage caption) uses
 * the `CASE` idiom the valuation reports use. On-hand only (`quantity > 0`) and unlimited-supply
 * items excluded (their quantity is meaningless for space).
 *
 * **This aggregate is NOT bounded by the location hierarchy, and never was** (issue #525): every
 * qualifying `item_stock` row is visited and joined back to `items`, so it costs O(stock), not
 * O(locations). `idx_item_stock_location_id` orders the grouping; it does not shrink the work.
 * It is therefore kept off the hot paths rather than made cheaper, in two steps:
 *
 * 1. It is **opt-in** — {@link LocationReadOptions.withVolume} — so the pickers, the bridge's
 *    id→name map, the export walk and the Dashboard's location tally never run it at all.
 * 2. Even when asked for, it runs only if the rows just read contain a location with a measured
 *    internal size ({@link rawContainerVolume}). Nothing else can render a volumetric bar, so a
 *    catalogue where no container has been measured — every catalogue, until someone enters a
 *    size — pays nothing for a feature it is not using.
 *
 * Attempts to make the aggregate itself proportional to the measured locations were measured and
 * rejected: restricting it to them leaves the planner (which has no statistics — Gubbins runs
 * `ANALYZE` only on Compact database) still driving from `items`, and forcing the other join
 * order with `CROSS JOIN` wins hugely when few locations are measured but costs ~1.8× when they
 * all are. Skipping the read outright has no such trade-off. Making the totals a
 * trigger-maintained cache, as `location_item_counts` is, remains the way to remove the cost for
 * a fully-measured catalogue.
 *
 * A separate statement, not a `LEFT JOIN` sub-select, because that is what lets step 2 decide
 * after seeing the rows; `LocationRepository.withVolumeTotals` pairs the two up. It also keeps a location
 * with no measured size free of a `volumeTotals` it can make no use of — a zeroed aggregate
 * there would read as "measured, and empty".
 *
 * Note this is a *different grain* from the `location_item_counts` counter above, which counts
 * active items by their **home** `location_id` regardless of quantity: so `total_items` here
 * (distinct items with stock physically placed at this location) can legitimately differ from
 * `item_count` (items homed here) when stock is split across locations or an item is unlimited.
 */
const VOLUME_TOTALS_SQL = `
  SELECT s.location_id AS location_id,
         SUM(i.width * i.height * i.depth * s.quantity) AS used_volume,
         SUM(CASE WHEN i.width IS NOT NULL AND i.height IS NOT NULL AND i.depth IS NOT NULL
                  THEN s.quantity ELSE 0 END) AS measured_units,
         SUM(s.quantity) AS total_units,
         COUNT(CASE WHEN i.width IS NOT NULL AND i.height IS NOT NULL AND i.depth IS NOT NULL
                    THEN 1 END) AS measured_items,
         COUNT(*) AS total_items
  FROM item_stock s
  JOIN items i ON i.id = s.item_id
  WHERE i.is_active = 1 AND s.quantity > 0 AND i.is_unlimited = 0
  GROUP BY s.location_id;
`;

const LOCATION_COLUMNS = `l.id, l.name, l.parent_id, l.is_system, l.description, l.color,
         l.icon, l.capacity, l.is_default, l.archived_at, l.last_counted_at,
         l.dead_stock_mode, l.dead_stock_days,
         l.width, l.height, l.depth, l.usable_volume, l.packing_factor,
         l.walk_order,
         l.updated_at,
         COALESCE(c.item_count, 0) AS item_count`;

const SELECT_WITH_COUNT = `
  SELECT ${LOCATION_COLUMNS}
  FROM locations l
  LEFT JOIN location_item_counts c ON c.location_id = l.id
`;

/** The shared ordering of every location read: the system locations first, then by name. */
const ORDER_BY_LOCATION = `ORDER BY l.is_system DESC, l.name COLLATE NOCASE ASC`;

/**
 * Cycle guard for a parent move (§7.5.3), designed to live in the WHERE clause of the
 * parent-setting `UPDATE` so the check and the write are ONE statement. The recursive CTE walks
 * up from the proposed new parent collecting its ancestors; if the moving node appears there, the
 * move would make a location its own descendant, the `NOT EXISTS` is false, and the `UPDATE`
 * matches zero rows instead of committing the loop.
 *
 * This closes a check-then-write race the standalone {@link LocationRepository.assertParentMoveValid}
 * pre-check cannot: because that check and the write are separate worker messages, two concurrent
 * re-parents (e.g. spamming drag-to-nest) could each pass the pre-check against pre-move state and
 * then both commit, forming A→B→A. Folding the guard into the write makes it atomic under the DB
 * worker's serialised message loop, so a cycle can never be committed no matter the interleaving.
 *
 * Binds, in order: the new parent id (CTE seed), then the moving location's id (the membership
 * test). Kept as a bare `NOT EXISTS (…)` fragment so callers append it to an existing WHERE.
 */
const PARENT_MOVE_CYCLE_GUARD = `NOT EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT ?
    UNION ALL
    SELECT l.parent_id FROM locations l JOIN ancestors a ON l.id = a.id WHERE l.parent_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = ?
)`;

export class LocationRepository extends BaseRepository {
  async getById(id: string): Promise<Location | undefined> {
    const row = await this.driver.queryOne<LocationRow>('SELECT * FROM locations WHERE id = ?;', [id]);
    return row ? rowToLocation(row) : undefined;
  }

  /**
   * A paginated flat list of locations with live (active) item counts.
   *
   * Note the volume aggregate, when asked for, groups the whole `item_stock` ledger however
   * small the page is — its cost tracks the stock, not the rows returned — so one page of a
   * `withVolume` read is no cheaper than the whole list. Another reason to leave it off unless a
   * fullness bar needs it (issue #525).
   */
  async list(params: PageParams & LocationReadOptions = {}): Promise<Page<LocationWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = (
      await this.driver.query<LocationCountRow>(
        `${SELECT_WITH_COUNT} ${ORDER_BY_LOCATION} LIMIT ? OFFSET ?;`,
        [limit, offset],
      )
    ).map(toWithCount);
    return this.toPage(await this.withVolumeTotals(rows, params.withVolume), limit, offset);
  }

  /**
   * How many locations exist — the whole physical hierarchy, archived branches included, exactly
   * as the flat list counts them.
   *
   * Its own read rather than `(await listAll()).length` (issue #525): the Dashboard's totals
   * widget wants one integer, and reading the rows to count them made it materialise every
   * location row to discard all but the length.
   */
  async count(): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM locations;');
    return Number(row?.n ?? 0);
  }

  /**
   * Every location as a flat list — the unpaginated counterpart to {@link getTree}, and
   * justified by the same reasoning: the location hierarchy is a bounded *physical* structure,
   * not the 100k+ item set the pagination mandate (§2.1) targets.
   *
   * The UI's flat list is not a "list" in the scrollable sense — it is the lookup table behind
   * the parent/location pickers, the ancestry and cycle maths, and the sidebar's search and tag
   * filters. All of those give *wrong* answers rather than merely short ones when a location is
   * missing from it (a search finds nothing, an ancestry breadcrumb stops early), so this read is
   * never capped. Use {@link list} where a genuine page is wanted.
   */
  async listAll(options: LocationReadOptions = {}): Promise<LocationWithCount[]> {
    const rows = (
      await this.driver.query<LocationCountRow>(`${SELECT_WITH_COUNT} ${ORDER_BY_LOCATION};`)
    ).map(toWithCount);
    return this.withVolumeTotals(rows, options.withVolume);
  }

  /**
   * The full location hierarchy as a nested tree (powers `useLocationTree`).
   * Locations are a bounded physical hierarchy (not the 100k+ item set), so a
   * single bounded read assembled in memory is appropriate here; the strict RPC
   * pagination mandate (§2.1) targets the item lists feeding virtualisation.
   *
   * That "bounded" holds for the default read only. Ask for `withVolume` and the read also walks
   * the `item_stock` ledger (see {@link LocationReadOptions.withVolume}) — the sidebar needs it
   * for its fill bars, a caller that only wants names and counts does not.
   */
  async getTree(options: LocationReadOptions = {}): Promise<LocationTreeNode[]> {
    const rows = (
      await this.driver.query<LocationCountRow>(`${SELECT_WITH_COUNT} ${ORDER_BY_LOCATION};`)
    ).map(toWithCount);
    return buildTree(await this.withVolumeTotals(rows, options.withVolume));
  }

  /**
   * The rows back, each measured location carrying its stock volume totals (issue #457) — or
   * unchanged when the caller did not ask, or when none of them is measured.
   *
   * The early return is the point (issue #525): the aggregate walks the whole `item_stock`
   * ledger, and a location with no measured internal size has no volumetric reading for it to
   * feed. Deciding *after* the rows are read is why the totals are a second statement rather
   * than a sub-select — see {@link VOLUME_TOTALS_SQL}.
   */
  private async withVolumeTotals(
    rows: readonly LocationWithCount[],
    withVolume: boolean | undefined,
  ): Promise<LocationWithCount[]> {
    if (withVolume !== true || !rows.some(isMeasured)) return [...rows];
    // Spelled as a template rather than the bare constant so `query-row-shape.test.ts` can see
    // the statement text and check this projection against it, as it does every other read here.
    const totals = await this.driver.query<LocationVolumeTotalsRow>(`${VOLUME_TOTALS_SQL}`);
    const byLocation = new Map(totals.map((row) => [row.location_id, row] as const));
    return rows.map((row) =>
      isMeasured(row) ? { ...row, volumeTotals: toVolumeTotals(byLocation.get(row.id)) } : row,
    );
  }

  async create(input: CreateLocationInput): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
    }
    assertTextLimit(name, TEXT_LIMITS.line, 'A location name');
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      await this.requireExists(parentId);
    }

    const id = crypto.randomUUID();
    const makeDefault = input.isDefault === true;
    const statements: SqlStatement[] = [];
    // Setting this new location as the default demotes any current default in the same
    // transaction, so at most one row ever carries the flag (§4 single-default invariant).
    if (makeDefault) {
      statements.push({ sql: 'UPDATE locations SET is_default = 0 WHERE is_default = 1;' });
    }
    statements.push({
      sql: `INSERT INTO locations (id, name, parent_id, description, color, icon, capacity, is_default,
                                   dead_stock_mode, dead_stock_days,
                                   width, height, depth, usable_volume, packing_factor, walk_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        name,
        parentId,
        normaliseText(input.description, TEXT_LIMITS.note, 'A location description'),
        normaliseText(input.color, TEXT_LIMITS.code, 'A location colour'),
        normaliseText(input.icon, TEXT_LIMITS.code, 'A location icon'),
        normaliseCapacity(input.capacity),
        makeDefault ? 1 : 0,
        // Defaults to 'inherit' so a new location defers to its parent — dead-stock
        // reporting stays opt-in until the user says otherwise (issue #92).
        input.deadStockMode ?? 'inherit',
        normaliseDeadStockDays(input.deadStockDays),
        // Internal size (issue #457): canonical mm dimensions and the optional mm³ / packing
        // overrides, each coerced to a non-negative REAL (or null) so a bad value never trips
        // the CHECKs. `createPath` spreads the same input onto each leaf, so leaves inherit
        // these for free; the bare ancestors created above never carry them (they pass no
        // dimensions), which is correct — ancestors are structural.
        normaliseDimension(input.width),
        normaliseDimension(input.height),
        normaliseDimension(input.depth),
        normaliseDimension(input.usableVolume),
        normalisePackingFactor(input.packingFactor),
        // Walk-order ordinal (issue #461); null when unplaced, coerced to a non-negative
        // integer so a bad value can never trip the CHECK.
        normaliseWalkOrder(input.walkOrder),
      ],
    });
    // The activity record starts where the location does (issue #691), in the same transaction
    // as the INSERT — a trail that begins mid-life leaves "when did this appear?" unanswerable.
    statements.push(
      locationHistoryStatement(id, name, 'CREATED', this.actorId(), {
        note: `Created "${name}".`,
        metadata: { parentId },
      }),
    );
    await this.driver.transaction(statements);
    return (await this.getById(id))!;
  }

  /**
   * Create a whole branch of the hierarchy from the nested-create shortcut (spec §4), which
   * spans two axes at once (see {@link parseLocationBranch}):
   *
   * - a `/`- or `\`-separated **path** goes *down* the tree, e.g. `Workshop/Cabinet A/Drawer 3`
   *   yields Workshop → Cabinet A → Drawer 3;
   * - a `,`-separated **list** at the leaf level fans *across* into siblings, e.g.
   *   `Garage/Box 1, Box 2, Box 3` yields three boxes under Garage.
   *
   * Each ancestor level is created under the running parent **only if a same-named child
   * doesn't already exist** there — an existing ancestor is reused, never duplicated — so the
   * same path can be typed repeatedly and only the genuinely-missing levels are added. The
   * intermediate ancestors are created bare; every leaf carries the full input (description,
   * colour, icon, capacity, default), since those are the locations the user was configuring;
   * a leaf that already exists is reused untouched rather than clobbered. Returns each resolved
   * leaf, in the order given. A single plain name (no separator) is exactly one leaf and behaves
   * exactly like {@link create}.
   *
   * The branch is created level-by-level rather than in one transaction: the hierarchy is a
   * small, low-frequency physical structure, and each {@link create} already carries the
   * INSERT + single-default-demotion invariants we want to reuse verbatim.
   */
  async createPath(input: CreateLocationInput): Promise<Location[]> {
    this.assertPermission('locations:write');
    this.assertWritable();
    const { ancestors, leaves } = parseLocationBranch(input.name);
    if (leaves.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
    }

    let parentId = input.parentId ?? null;
    if (parentId !== null) {
      await this.requireExists(parentId);
    }

    // Walk the shared ancestor chain: reuse a level if present, else create it bare.
    for (const level of ancestors) {
      const existing = await this.findChildByName(parentId, level);
      parentId = existing ? existing.id : (await this.create({ name: level, parentId })).id;
    }

    // Create each leaf sibling under the resolved parent, reusing any that already exist so the
    // shortcut only ever fills in what's missing.
    const created: Location[] = [];
    for (const leafName of leaves) {
      const existingLeaf = await this.findChildByName(parentId, leafName);
      created.push(existingLeaf ?? (await this.create({ ...input, name: leafName, parentId })));
    }
    return created;
  }

  async update(id: string, input: UpdateLocationInput): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    // Kept, rather than discarded as a mere existence check: the activity record (issue #691) is
    // a diff, so it needs the row as it stands *before* the write. One read serves both.
    const before = await this.assertMutable(id);

    if (input.parentId !== undefined) {
      await this.assertParentMoveValid(id, input.parentId);
    }

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A location must have a name.');
      }
      assertTextLimit(name, TEXT_LIMITS.line, 'A location name');
      sets.push('name = ?');
      params.push(name);
    }
    if (input.parentId !== undefined) {
      sets.push('parent_id = ?');
      params.push(input.parentId);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(normaliseText(input.description, TEXT_LIMITS.note, 'A location description'));
    }
    if (input.color !== undefined) {
      sets.push('color = ?');
      params.push(normaliseText(input.color, TEXT_LIMITS.code, 'A location colour'));
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?');
      params.push(normaliseText(input.icon, TEXT_LIMITS.code, 'A location icon'));
    }
    if (input.capacity !== undefined) {
      sets.push('capacity = ?');
      params.push(normaliseCapacity(input.capacity));
    }
    if (input.isDefault !== undefined) {
      sets.push('is_default = ?');
      params.push(input.isDefault ? 1 : 0);
    }
    if (input.archivedAt !== undefined) {
      sets.push('archived_at = ?');
      params.push(input.archivedAt);
    }
    if (input.deadStockMode !== undefined) {
      // Dead-stock reporting for everything stored here (issue #92); 'inherit' hands the
      // decision back to the parent location. The DB CHECK mirrors DEAD_STOCK_MODES.
      sets.push('dead_stock_mode = ?');
      params.push(input.deadStockMode);
    }
    if (input.deadStockDays !== undefined) {
      // An idle-days override for this subtree; null defers up the tree to the global
      // preference. Clamped so a mistyped value can't disable the report or flag everything.
      sets.push('dead_stock_days = ?');
      params.push(normaliseDeadStockDays(input.deadStockDays));
    }
    // Internal size (issue #457): each is cleared-or-set independently, so an untouched field
    // (undefined) never rewrites the stored value. `null` clears; a number is coerced to a
    // safe non-negative REAL (dimensions/volume) or clamped to (0,1] (packing factor).
    if (input.width !== undefined) {
      sets.push('width = ?');
      params.push(normaliseDimension(input.width));
    }
    if (input.height !== undefined) {
      sets.push('height = ?');
      params.push(normaliseDimension(input.height));
    }
    if (input.depth !== undefined) {
      sets.push('depth = ?');
      params.push(normaliseDimension(input.depth));
    }
    if (input.usableVolume !== undefined) {
      sets.push('usable_volume = ?');
      params.push(normaliseDimension(input.usableVolume));
    }
    if (input.packingFactor !== undefined) {
      sets.push('packing_factor = ?');
      params.push(normalisePackingFactor(input.packingFactor));
    }
    // Picking-sweep position (issue #461): null clears (unplaced, sorts last), a number is
    // coerced to a non-negative integer. Undefined leaves the stored value untouched.
    if (input.walkOrder !== undefined) {
      sets.push('walk_order = ?');
      params.push(normaliseWalkOrder(input.walkOrder));
    }

    // Only guard when nesting under a real parent — a move to the root (null) can never cycle.
    const guardCycle = input.parentId != null;
    // The activity entries this edit records (issue #691), resolved before the transaction is
    // assembled because naming the parents either side of a move costs a read each.
    const history = sets.length > 0 ? await this.updateHistoryStatements(id, before, input, guardCycle) : [];
    if (sets.length > 0) {
      const statements: SqlStatement[] = [];
      // Promoting this row to the default demotes any other default in the same
      // transaction (§4 single-default invariant); exclude self so the flag survives. The demotion
      // carries the SAME cycle guard as the main update below, so that if a concurrent re-parent
      // has made this an illegal move the whole transaction no-ops together — never clearing the
      // old default while the guarded main update refuses to set the new one.
      if (input.isDefault === true) {
        statements.push({
          sql: `UPDATE locations SET is_default = 0 WHERE is_default = 1 AND id <> ?${guardCycle ? ` AND ${PARENT_MOVE_CYCLE_GUARD}` : ''};`,
          params: guardCycle ? [id, input.parentId, id] : [id],
        });
      }
      // Emitted *before* the UPDATE, the same way a gauge's ledger entry is (see
      // `gaugeDeltaHistoryStatement`), so each entry's guard is evaluated against exactly the
      // pre-write state the UPDATE's own guard sees.
      statements.push(...history);
      // The cycle guard rides in the WHERE so the check is atomic with the write (see
      // PARENT_MOVE_CYCLE_GUARD): a concurrent re-parent cannot slip a loop past it. When it
      // vetoes the move the whole UPDATE matches zero rows — detected via the re-read below.
      statements.push({
        sql: `UPDATE locations SET ${sets.join(', ')} WHERE id = ?${guardCycle ? ` AND ${PARENT_MOVE_CYCLE_GUARD}` : ''};`,
        params: guardCycle ? [...params, id, input.parentId, id] : [...params, id],
      });
      await this.driver.transaction(statements);
    }
    const updated = (await this.getById(id))!;
    // If a requested (non-null) parent move didn't land, the atomic guard refused it because a
    // concurrent re-parent had already made the target a descendant between our pre-check and our
    // write. Surface the same cycle error the pre-check raises so the loser of the race is told,
    // rather than reporting a silent no-op as success.
    if (guardCycle && updated.parentId !== input.parentId) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Moving this location there would create a cyclical nesting loop.',
      );
    }
    return updated;
  }

  /**
   * Mark a location as the single default (pre-selected when adding items), or clear the
   * default entirely. Setting a new default demotes the previous one atomically; system
   * locations may never be the default.
   */
  async setDefault(id: string): Promise<Location> {
    this.assertPermission('locations:write');
    return this.update(id, { isDefault: true });
  }

  /** Soft-archive a location (hide it from the tree/pickers) or restore it. */
  async setArchived(id: string, archived: boolean): Promise<Location> {
    this.assertPermission('locations:write');
    return this.update(id, { archivedAt: archived ? Date.now() : null });
  }

  /**
   * Stamp a location as counted just now (spec §4.4 stock-take group G) — the durable
   * "last counted" record written whenever a cycle-count/audit-day walk completes at this
   * location, whether the count was clean or reconciled variances. Deliberately its own
   * method rather than a field on {@link update}: it carries no other input, needs no
   * cycle guard, and is called from the count engine rather than a location-edit form.
   *
   * A system location cannot be stamped: `trg_locations_protect_system_update` aborts *any*
   * UPDATE on one, so the guard here only surfaces that as a clear error rather than a raw
   * constraint failure. Counting one is still allowed — see `authoriseCount`, which simply
   * omits the stamp rather than failing the whole count over it (issue #301).
   */
  async markCounted(id: string, at: number = Date.now()): Promise<Location> {
    this.assertPermission('locations:write');
    this.assertWritable();
    await this.assertMutable(id);
    const { sql, params } = markCountedStatement(id, at);
    await this.driver.execute(sql, params ?? []);
    return (await this.getById(id))!;
  }

  /**
   * Delete a location. Orphaned items default to Unassigned (§4); child locations
   * are promoted to the deleted node's parent. The whole operation is one atomic
   * transaction, and each re-parented item gets an Activity Log entry. Deletes are
   * permitted even under the storage Hard Stop (they free space).
   *
   * Every tool still out *to* this location as a borrower is returned first (B4), inside this
   * same transaction (issue #301) rather than a preceding awaited call — so a failed delete
   * can't leave those loans force-returned against a location that still exists.
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('locations:delete');
    const location = await this.getById(id);
    if (!location) return;
    if (location.isSystem) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The Unassigned location is system-locked and cannot be deleted.',
      );
    }

    // Return every loan borrowed *by* this location before anything else, so the restored
    // stock lands while the location's placements still exist and is then re-homed to
    // Unassigned by the batch move below along with the rest. (This is the loan *target*; the
    // distinct `source_location_id` pointer is nulled separately further down.)
    const returns = await planCheckInAllForTarget(this.driver, 'location', id, this.actorId());

    const orphanedItems = await this.driver.query<{ id: string }>(
      'SELECT id FROM items WHERE location_id = ?;',
      [id],
    );

    const statements: SqlStatement[] = [...returns];

    // Re-parent orphaned items to Unassigned and log each move.
    if (orphanedItems.length > 0) {
      statements.push({
        sql: 'UPDATE items SET location_id = ? WHERE location_id = ?;',
        params: [UNASSIGNED_LOCATION_ID, id],
      });
      for (const item of orphanedItems) {
        statements.push(
          historyStatement(item.id, 'RE_PARENTED', this.actorId(), {
            note: `Re-parented to Unassigned: location "${location.name}" was deleted.`,
            metadata: { fromLocationId: id, toLocationId: UNASSIGNED_LOCATION_ID },
          }),
        );
      }
    }

    // Re-home every batch sitting at the deleted location into each item's Unassigned
    // placement (Phase 28 — `stock_batches` is the SSOT below `item_stock`), preserving each
    // lot's identity and merging same-key lots by the deterministic batch id. The recompute
    // triggers then re-derive `item_stock.quantity` (and `items.quantity`) at Unassigned, so
    // the grand total per item is preserved (the units just move home). The deleted
    // location's batch and placement rows are then dropped — otherwise their RESTRICT foreign
    // key would block the delete.
    //
    // Deferred, and settled once at the end (issue #640). The re-home fills the Unassigned
    // placement before the deleted one is dropped, so with the recompute triggers live an item's
    // total is briefly doubled — which for a SERIALISED instance breaches
    // `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` and aborted the delete outright,
    // making a location holding any serialised unit undeletable. The bracket also repairs where
    // each serialised unit sits, which is right here: the items homed at this location were
    // re-pointed at Unassigned a few statements above.
    statements.push(
      ...withRecomputeDeferred([
        {
          sql: `INSERT INTO stock_batches
              (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
            SELECT item_id || '|' || ? || '|' || batch_key, item_id, ?, batch_key,
                   batch_number, lot_number, expiry_date, quantity
            FROM stock_batches WHERE location_id = ? AND quantity > 0
            ON CONFLICT(id) DO UPDATE SET quantity = stock_batches.quantity + excluded.quantity;`,
          params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_ID, id],
        },
        { sql: 'DELETE FROM stock_batches WHERE location_id = ?;', params: [id] },
        { sql: 'DELETE FROM item_stock WHERE location_id = ?;', params: [id] },
      ]),
    );

    // Clear the lend-from pointer on any checkout drawn from this location (Phase 26):
    // an open loan's returned stock will fall back to the item's primary location, and the
    // nullable FK would otherwise block the location's RESTRICT delete (mirrors the §7.5.2
    // sync `applyPlan` null-out).
    statements.push({
      sql: 'UPDATE checkouts SET source_location_id = NULL WHERE source_location_id = ?;',
      params: [id],
    });

    // Clear the per-location scope on any maintenance schedule pinned to this location
    // (Phase 30): the schedule reverts to item-level rather than vanishing, and the
    // nullable RESTRICT FK would otherwise block the delete (mirrors the §7.5.2 sync
    // `applyPlan` null-out and the checkout source above).
    statements.push({
      sql: 'UPDATE maintenance_schedules SET location_id = NULL WHERE location_id = ?;',
      params: [id],
    });

    // Promote child locations to the deleted node's parent, and record the move on each of them
    // (issue #691). A promotion reshapes the hierarchy exactly as an ordinary re-parent does, and
    // it is the one that happens *to* somebody rather than being asked for — so leaving it silent
    // would make "why is this shelf suddenly under a different room?" unanswerable in precisely the
    // case the question is most likely to be asked. This mirrors the per-item `RE_PARENTED` entries
    // the orphan re-home writes above.
    const promoted = await this.driver.query<{ id: string; name: string }>(
      'SELECT id, name FROM locations WHERE parent_id = ?;',
      [id],
    );
    statements.push({
      sql: 'UPDATE locations SET parent_id = ? WHERE parent_id = ?;',
      params: [location.parentId, id],
    });
    const promotedTo = await this.parentLabel(location.parentId);
    for (const child of promoted) {
      statements.push(
        locationHistoryStatement(child.id, child.name, 'RE_PARENTED', this.actorId(), {
          note: `Moved from "${location.name}" to ${promotedTo}: "${location.name}" was deleted.`,
          metadata: { fromParentId: id, toParentId: location.parentId },
        }),
      );
    }

    // Record the deletion itself (issue #691). `location_history.location_id` carries no foreign
    // key, so this location's whole trail — this entry included — outlives the `DELETE` below
    // still naming which location it was about. A place that was removed is exactly the case
    // where "what happened to it?" is worth answering, and a cascade would answer it by
    // destroying the evidence.
    statements.push(
      locationHistoryStatement(id, location.name, 'DELETED', this.actorId(), {
        note:
          `Deleted "${location.name}". ` +
          `${orphanedItems.length === 1 ? '1 item was' : `${orphanedItems.length} items were`} ` +
          `moved to Unassigned; ` +
          `${promoted.length === 1 ? '1 sub-location was' : `${promoted.length} sub-locations were`} ` +
          `moved to ${promotedTo}.`,
        metadata: {
          parentId: location.parentId,
          itemsReHomed: orphanedItems.length,
          subLocationsPromoted: promoted.length,
        },
      }),
    );

    statements.push({ sql: 'DELETE FROM locations WHERE id = ?;', params: [id] });
    // Propagate the hard delete on the next sync (§7.2). Re-parented items keep
    // their own (live) rows; only the removed location is tombstoned.
    statements.push(tombstoneStatement('locations', id));

    await this.driver.transaction(statements);
  }

  /**
   * One page of a location's activity record, newest first (issue #691) — what the location
   * editor's History tab reads.
   *
   * Paged rather than read whole for the same reason the item Activity Log is: a location that is
   * re-parented and archived repeatedly across a shared vault accumulates entries without bound,
   * and a capped read that looked like the whole set would be a lie about an audit trail.
   *
   * `rowid` is the deterministic insertion-order tiebreaker when several entries share a
   * `created_at` millisecond — a single edit that renames *and* moves writes two.
   */
  async getHistory(locationId: string, params: PageParams = {}): Promise<Page<LocationHistoryEntry>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<LocationHistoryWithActorRow>(
      // The `users` LEFT JOIN resolves the actor's display name (issue #774) — see
      // {@link LocationHistoryWithActorRow} for why it is a *left* join.
      `SELECT h.*, u.display_name AS actor_display_name
       FROM location_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.location_id = ?
       ORDER BY h.created_at DESC, h.rowid DESC
       LIMIT ? OFFSET ?;`,
      [locationId, limit, offset],
    );
    return this.toPage(rows.map(rowToLocationHistoryEntry), limit, offset);
  }

  /**
   * One page of the activity record across **every** location, newest first — the cross-location
   * counterpart of {@link getHistory}, and the read the bridge's event generation diffs to decide
   * what is new since the last hydration (issue #691).
   *
   * Entries about a location that has since been deleted are deliberately included — a `DELETED`
   * entry is precisely the one an automation most wants — and they still carry both the id and the
   * name the place had, because `location_id` is a historical coordinate rather than a foreign key
   * (see the table's schema note). That is also what makes this the *only* in-app reader a deleted
   * location's trail can have: the History tab is opened from a location, and there is no longer a
   * location to open (issue #693).
   *
   * `actions` restricts the feed to a subset of actions for the Activity screen's filter chips,
   * with the same empty-array sentinel the item feed uses — see
   * {@link LocationHistoryFeedFilters}.
   */
  async getHistoryFeed(filters: LocationHistoryFeedFilters = {}): Promise<Page<LocationHistoryEntry>> {
    const { limit, offset } = this.resolvePage(filters);
    const actions = filters.actions;
    // An explicit empty filter list means "match nothing" — return early without a query.
    if (actions !== undefined && actions.length === 0) return this.toPage([], limit, offset);
    const rows = await this.driver.query<LocationHistoryWithActorRow>(
      `SELECT h.*, u.display_name AS actor_display_name
       FROM location_history h
       LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE (${locationHistoryActionFilter(actions, 'h.')})
       ORDER BY h.created_at DESC, h.rowid DESC
       LIMIT ? OFFSET ?;`,
      [...(actions ?? []), limit, offset],
    );
    return this.toPage(rows.map(rowToLocationHistoryEntry), limit, offset);
  }

  /**
   * Total number of {@link getHistoryFeed} rows under the same `actions` filter — the denominator
   * the Activity screen's paginated mode needs to size its page count (issue #693). Mirrors the
   * feed's `WHERE` exactly, so the count can never disagree with the pages it sizes; an explicit
   * empty `actions` array is "match nothing" → 0.
   */
  async countHistoryFeed(filters: Pick<LocationHistoryFeedFilters, 'actions'> = {}): Promise<number> {
    const actions = filters.actions;
    if (actions !== undefined && actions.length === 0) return 0;
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM location_history WHERE (${locationHistoryActionFilter(actions)});`,
      [...(actions ?? [])],
    );
    return Number(row?.n ?? 0);
  }

  // --- internals -----------------------------------------------------------------

  /**
   * The activity entries an {@link update} records (issue #691) — one per hierarchy-reshaping
   * change it actually makes, and none for the rest.
   *
   * Only the changes a user cannot otherwise reconstruct are recorded: a rename, a move, and the
   * archive/restore toggle. Colour, capacity, dimensions, walk order, the default flag and the
   * dead-stock policy write nothing, deliberately — see {@link LOCATION_HISTORY_ACTIONS}. Nor does
   * an edit that sets a column to the value it already held: a save with no net change is not an
   * event, and recording it would bury the ones that are.
   *
   * When `guardCycle` is set, every entry carries the same atomic cycle guard the `UPDATE` does,
   * so a move a concurrent re-parent has made illegal records nothing at all — including the
   * rename that would have ridden the same vetoed statement.
   */
  private async updateHistoryStatements(
    id: string,
    before: Location,
    input: UpdateLocationInput,
    guardCycle: boolean,
  ): Promise<SqlStatement[]> {
    const guard: LocationHistoryFields['guard'] = guardCycle
      ? { sql: PARENT_MOVE_CYCLE_GUARD, params: [input.parentId!, id] }
      : undefined;
    // The name the location carries *after* this edit, so every entry reads as the location the
    // user is now looking at; the previous name lives in the rename entry's note and metadata.
    const name = input.name !== undefined ? input.name.trim() : before.name;
    const statements: SqlStatement[] = [];
    const entry = (action: LocationHistoryAction, fields: LocationHistoryFields = {}) =>
      statements.push(locationHistoryStatement(id, name, action, this.actorId(), { ...fields, guard }));

    if (input.name !== undefined && name !== before.name) {
      entry('RENAMED', {
        note: `Renamed from "${before.name}" to "${name}".`,
        metadata: { fromName: before.name, toName: name },
      });
    }

    if (input.parentId !== undefined && (input.parentId ?? null) !== before.parentId) {
      const toId = input.parentId ?? null;
      const [fromName, toName] = await Promise.all([
        this.parentLabel(before.parentId),
        this.parentLabel(toId),
      ]);
      entry('RE_PARENTED', {
        note: `Moved from ${fromName} to ${toName}.`,
        metadata: { fromParentId: before.parentId, toParentId: toId },
      });
    }

    // Archive and restore are the two directions of one nullable column, so the transition — not
    // the value — is what decides which action (if either) is recorded.
    if (input.archivedAt !== undefined) {
      const wasArchived = before.archivedAt != null;
      const nowArchived = input.archivedAt != null;
      if (wasArchived !== nowArchived) {
        entry(nowArchived ? 'ARCHIVED' : 'RESTORED', {
          note: nowArchived
            ? `Archived "${name}". It is hidden from the tree and the pickers; nothing stored here moved.`
            : `Restored "${name}" to the active hierarchy.`,
        });
      }
    }

    return statements;
  }

  /**
   * A parent's display name for an activity note, or "the top level" for the root. Quoted here
   * rather than by the caller so the two arms read as one sentence either way, and falling back to
   * the bare id keeps a note honest when the parent cannot be read.
   */
  private async parentLabel(parentId: string | null): Promise<string> {
    if (parentId === null) return 'the top level';
    const parent = await this.getById(parentId);
    return `"${parent?.name ?? parentId}"`;
  }

  /**
   * Find a direct child of `parentId` (or a root, when null) whose name matches `name`
   * case-insensitively — the "does this level already exist?" lookup that lets
   * {@link createPath} reuse an ancestor instead of duplicating it. The NOCASE match mirrors
   * the tree's `name COLLATE NOCASE` ordering, so `workshop` and `Workshop` are one level.
   */
  private async findChildByName(parentId: string | null, name: string): Promise<Location | undefined> {
    const trimmed = name.trim();
    const row = await this.driver.queryOne<LocationRow>(
      parentId === null
        ? 'SELECT * FROM locations WHERE parent_id IS NULL AND name = ? COLLATE NOCASE LIMIT 1;'
        : 'SELECT * FROM locations WHERE parent_id = ? AND name = ? COLLATE NOCASE LIMIT 1;',
      parentId === null ? [trimmed] : [parentId, trimmed],
    );
    return row ? rowToLocation(row) : undefined;
  }

  private async requireExists(id: string): Promise<void> {
    const exists = await this.driver.queryOne('SELECT 1 AS ok FROM locations WHERE id = ?;', [id]);
    if (!exists) {
      throw new DbError('SQLITE_CONSTRAINT_FOREIGNKEY', `Location "${id}" does not exist.`);
    }
  }

  /** Assert the location exists and is not system-locked, returning it so callers reuse the read. */
  private async assertMutable(id: string): Promise<Location> {
    const location = await this.getById(id);
    if (!location) {
      throw new DbError('SQLITE_CONSTRAINT', `Location "${id}" does not exist.`);
    }
    if (location.isSystem) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The Unassigned location is system-locked and cannot be modified.',
      );
    }
    return location;
  }

  /**
   * Reject a parent move that would create a cycle (§7.5.3): a location may not
   * become its own descendant. Walks up from the proposed parent via a recursive
   * CTE; a cycle exists if the moving node appears in that ancestor chain.
   */
  private async assertParentMoveValid(id: string, newParentId: string | null): Promise<void> {
    if (newParentId === null) return;
    if (newParentId === id) {
      throw new DbError('SQLITE_CONSTRAINT', 'A location cannot be its own parent.');
    }
    await this.requireExists(newParentId);

    // UNION (not UNION ALL) terminates even if the data somehow already held a cycle
    // (issue #190) — otherwise this walk runs forever and hangs the database worker.
    const cycle = await this.driver.queryOne<{ id: string }>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION
         SELECT l.parent_id FROM locations l
         JOIN ancestors a ON l.id = a.id
         WHERE l.parent_id IS NOT NULL
       )
       SELECT id FROM ancestors WHERE id = ? LIMIT 1;`,
      [newParentId, id],
    );
    if (cycle) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Moving this location there would create a cyclical nesting loop.',
      );
    }
  }
}

/** A location row plus its item count — the default read, which computes no volume totals. */
function toWithCount(row: LocationCountRow): LocationWithCount {
  return { ...rowToLocation(row), itemCount: Number(row.item_count) };
}

/**
 * Does this location have a measured internal size — i.e. can a volumetric fullness bar be drawn
 * for it at all? The same question `locationCapacityVolume` asks before scaling by the packing
 * factor, and the one that decides whether the volume aggregate is worth running (issue #525).
 */
function isMeasured(location: LocationWithCount): boolean {
  return rawContainerVolume(location.usableVolume, location.width, location.height, location.depth) !== null;
}

/**
 * One location's aggregated row as {@link LocationVolumeTotals}, or a zeroed aggregate when the
 * aggregate produced no group for it — a measured location that holds no countable stock, which
 * is a genuine zero and not a missing reading.
 */
function toVolumeTotals(row: LocationVolumeTotalsRow | undefined): LocationVolumeTotals {
  return {
    usedVolume: Number(row?.used_volume ?? 0),
    measuredUnits: Number(row?.measured_units ?? 0),
    totalUnits: Number(row?.total_units ?? 0),
    measuredItems: Number(row?.measured_items ?? 0),
    totalItems: Number(row?.total_items ?? 0),
  };
}

/**
 * Trim a free-text/key field, collapsing blank/whitespace-only input to NULL, and refuse one
 * longer than its column will take (issue #346). `subject` names the field in the refusal.
 */
function normaliseText(value: string | null | undefined, limit: number, subject: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  assertTextLimit(trimmed, limit, subject);
  return trimmed;
}

/**
 * Coerce a capacity to a non-negative integer, or NULL for "unbounded". A blank, NaN,
 * negative or non-finite value collapses to NULL so a cleared field means "no limit".
 */
function normaliseCapacity(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Coerce a location dimension / usable-volume to a non-negative finite REAL, or NULL for "not
 * measured" (issue #457). Unlike {@link normaliseCapacity} these are REAL columns (canonical mm
 * / mm³, a 30.5 mm drawer is real), so the value is kept whole — **no `Math.floor`**. A blank,
 * NaN, negative or non-finite value collapses to NULL so a cleared field means "not measured".
 */
function normaliseDimension(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Coerce a per-location packing factor to the safe `[min, 1]` fraction, or NULL to defer to the
 * global `defaultPackingFactor` preference (issue #457). Zero, negative, > 1, NaN or non-finite
 * collapse to NULL ("no override"); a positive-but-below-floor value is clamped **up** to the same
 * floor the global default and the entry field enforce, so no write path (import, sync, API) can
 * store a near-zero factor that would make a measured location read as wildly over-full.
 */
function normalisePackingFactor(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0 || value > 1) return null;
  return Math.max(PACKING_FACTOR_BOUNDS.min, value);
}

/**
 * Coerce a walk-order ordinal to a non-negative integer, or NULL for "unplaced" (issue #461).
 * A blank, NaN, negative or non-finite value collapses to NULL so a cleared field drops the
 * location off the route — where it sorts after every placed location. Floored to a whole
 * number: walk order is a rung on a sequence, not a measured quantity.
 */
function normaliseWalkOrder(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/**
 * Normalise a location's dead-stock idle-days override (issue #92): null/blank/invalid ⇒
 * no override (defer up the tree), otherwise a whole number clamped to the same bounds the
 * global preference uses, so the DB's `> 0` CHECK can never be tripped by user input.
 */
function normaliseDeadStockDays(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return clampDeadStockDays(value);
}

/** Assemble flat rows into a parent/child tree, preserving input ordering. */
function buildTree(nodes: readonly LocationWithCount[]): LocationTreeNode[] {
  const byId = new Map<string, LocationTreeNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });

  const roots: LocationTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId !== null && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
