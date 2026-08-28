/**
 * Project, BOM-line, costing, shopping-list, and assembly-finalisation types
 * (spec §4 "Projects & BOMs", Phase 4; BOM Costing; Composite Items & Assemblies).
 */
import type {
  AssemblyOutcome,
  CostingMode,
  ProcurementStatus,
  ProjectStatus,
  ReservationStatus,
} from '../constants';
import type { PageParams } from './pagination';
import type { ItemStockPlacement } from './stock';

// --- Projects (spec §4 "Projects & BOMs", Phase 4) ------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Optional icon: a canonical Lucide glyph name (PascalCase), or NULL for the default. */
  readonly icon: string | null;
  readonly status: ProjectStatus;
  readonly costing_mode: CostingMode;
  /** Optional overall budget (§4 budgeting); NULL = no budget set. */
  readonly budget: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Optional icon: a canonical Lucide glyph name (PascalCase), or null for the default. */
  readonly icon: string | null;
  readonly status: ProjectStatus;
  readonly costingMode: CostingMode;
  /** Optional overall budget (§4 budgeting); null = no budget set. */
  readonly budget: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A project plus its denormalised BOM-line count, for the list view. */
export interface ProjectWithCount extends Project {
  readonly lineCount: number;
}

/**
 * What narrows a project read (issue #137).
 *
 * The master list is the only way into a project, so once there are more projects than fit on a
 * page, "find the one I mean" has to be something other than paging blindly. `search` is a
 * case-insensitive substring of the project's **name** — what the list actually prints, so a
 * match is always visible as the reason the row is there — and `status` narrows to one stage of
 * the build lifecycle (the everyday "hide the finished ones").
 *
 * `statuses` is the same narrowing over a *set* of stages, for the questions a single stage
 * cannot ask — "how many projects are still live?" is every status bar the terminal ones
 * (`ACTIVE_PROJECT_STATUSES`), which the Dashboard's Projects tile counts (issue #573). Both may
 * be given, in which case a project must satisfy both. An **empty** `statuses` array matches
 * nothing, which is what "none of these stages" means.
 */
export interface ProjectFilter {
  readonly search?: string;
  readonly status?: ProjectStatus;
  readonly statuses?: readonly ProjectStatus[];
}

/**
 * How the project list is ordered (issue #137). Newest-first is the default and the order the
 * list has always used; the rest exist because "which did I start first" and "find it
 * alphabetically" are the two other ways a shelf of projects is looked through.
 */
export type ProjectSort = 'NEWEST' | 'OLDEST' | 'NAME_ASC' | 'NAME_DESC';

/** {@link ProjectFilter} plus the ordering and the page to read of the matching projects. */
export interface ProjectListParams extends PageParams, ProjectFilter {
  readonly sort?: ProjectSort;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string | null;
  /** Optional icon: a canonical Lucide glyph name (PascalCase); null/omitted = default. */
  readonly icon?: string | null;
  readonly costingMode?: CostingMode;
  /** Optional overall budget set at creation (§4 budgeting). */
  readonly budget?: number | null;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  /** Set or clear (null) the project's icon (a canonical Lucide glyph name). */
  readonly icon?: string | null;
  readonly status?: ProjectStatus;
  readonly costingMode?: CostingMode;
  /** Set or clear (null) the overall budget (§4 budgeting). */
  readonly budget?: number | null;
}

// --- BOM lines (spec §4) --------------------------------------------------------

export interface ProjectBomLineRow {
  readonly id: string;
  readonly project_id: string;
  readonly item_id: string | null;
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly description: string | null;
  readonly required_qty: number;
  readonly reserved_qty: number;
  /** Cumulative quantity received so far (§4 partial / split receipts, Phase 24). */
  readonly received_qty: number;
  /** 1 once the line has been physically gathered in the picking pass (issue #121). */
  readonly picked: number;
  readonly reservation_status: ReservationStatus;
  readonly procurement_status: ProcurementStatus;
  readonly unit_cost_snapshot: number | null;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ProjectBomLine {
  readonly id: string;
  readonly projectId: string;
  /** The matched local item, or null for an unmatched (manual/import) line. */
  readonly itemId: string | null;
  /** Free-text reference designator(s) (e.g. KiCad "R1, R2"). */
  readonly designator: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /** Free-text part description; the display name when there is no matched item. */
  readonly description: string | null;
  readonly requiredQty: number;
  readonly reservedQty: number;
  /** Cumulative quantity received so far (§4 partial / split receipts, Phase 24). */
  readonly receivedQty: number;
  /** True once the line has been physically gathered in the picking pass (issue #121). */
  readonly picked: boolean;
  readonly reservationStatus: ReservationStatus;
  readonly procurementStatus: ProcurementStatus;
  /** Point-in-time unit cost captured when the line was added (§4 BOM Costing). */
  readonly unitCostSnapshot: number | null;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateBomLineInput {
  /** Match to a local item; when set, mpn/manufacturer/cost snapshot default from it. */
  readonly itemId?: string | null;
  readonly designator?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  readonly description?: string | null;
  readonly requiredQty?: number;
  readonly position?: number;
}

export interface UpdateBomLineInput {
  readonly itemId?: string | null;
  readonly designator?: string | null;
  readonly mpn?: string | null;
  readonly manufacturer?: string | null;
  readonly description?: string | null;
  readonly requiredQty?: number;
  readonly position?: number;
}

// --- Budgeting (spec §4, on top of BOM Costing) ---------------------------------

/** A named sub-budget bucket on a project (e.g. "Parts", "Shipping", "Labour"). */
export interface ProjectBudgetCategoryRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly amount: number;
  readonly position: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ProjectBudgetCategory {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  /** The allocated sub-budget for this category. */
  readonly amount: number;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A budget category joined with its recorded spend (Σ assigned expenses). */
export interface ProjectBudgetCategoryRollup {
  readonly id: string;
  readonly name: string;
  readonly amount: number;
  readonly position: number;
  readonly spent: number;
}

export interface CreateBudgetCategoryInput {
  readonly name: string;
  readonly amount?: number;
  readonly position?: number;
}

export interface UpdateBudgetCategoryInput {
  readonly name?: string;
  readonly amount?: number;
  readonly position?: number;
}

/** A single recorded expense in a project's manual spend ledger (§4 budgeting). */
export interface ProjectExpenseRow {
  readonly id: string;
  readonly project_id: string;
  readonly category_id: string | null;
  readonly description: string | null;
  readonly amount: number;
  readonly incurred_at: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ProjectExpense {
  readonly id: string;
  readonly projectId: string;
  /** The budget category this expense is filed under, or null (uncategorised). */
  readonly categoryId: string | null;
  readonly description: string | null;
  readonly amount: number;
  /** When the cost was incurred (UNIX-ms); defaults to now when omitted. */
  readonly incurredAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateExpenseInput {
  readonly description?: string | null;
  readonly amount: number;
  readonly categoryId?: string | null;
  readonly incurredAt?: number;
}

export interface UpdateExpenseInput {
  readonly description?: string | null;
  readonly amount?: number;
  readonly categoryId?: string | null;
  readonly incurredAt?: number;
}

/**
 * The raw budget aggregates the repository gathers for one project — the facts the pure
 * `summariseBudget` derives spent/remaining/projected/status from. `committedFromBom`
 * (`Σ received_qty × unit cost`) and `estimatedCost` (full BOM) are derived live from the
 * BOM under the project's costing mode, never stored, so they cannot drift.
 */
export interface ProjectBudget {
  readonly projectId: string;
  readonly budget: number | null;
  readonly estimatedCost: number;
  readonly committedFromBom: number;
  readonly manualExpenseTotal: number;
  readonly categories: readonly ProjectBudgetCategoryRollup[];
  /** Manual spend with no category assigned. */
  readonly uncategorisedExpenseTotal: number;
}

/**
 * A cross-project budget headline for the dashboard "Budget alerts" feed: one row per
 * project that has a budget set, carrying the figures the widget needs to flag near- and
 * over-budget projects without re-fetching each project's full rollup.
 */
export interface ProjectBudgetAlert {
  readonly projectId: string;
  readonly projectName: string;
  readonly budget: number;
  readonly committedFromBom: number;
  readonly manualExpenseTotal: number;
  readonly estimatedCost: number;
}

// --- Costing & shopping list (spec §4 BOM Costing; automated Shopping List) ------

/** A project's costed totals under the active costing mode. */
export interface ProjectCosting {
  readonly costingMode: CostingMode;
  /** Total cost = Σ requiredQty × unit cost (live or snapshot per the mode). */
  readonly totalCost: number;
  /** Lines whose unit cost is unknown under the active mode (excluded from total). */
  readonly unpricedLineCount: number;
  readonly lineCount: number;
}

/** A single aggregated shortfall row in a project's automated shopping list. */
export interface ShoppingListEntry {
  /** Matched item id when the shortfall maps to a known item, else null. */
  readonly itemId: string | null;
  /** Display label (item name, else description/mpn/designator). */
  readonly label: string;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  /**
   * Quantity still to acquire, summed across merged lines: what the lines require, less the
   * part of their reservation real stock actually backs (issue #653). A reservation another
   * project's claim beat to the stock buys nothing, so it does not reduce this.
   */
  readonly shortfallQty: number;
  /**
   * Of {@link shortfallQty}, how many units this project *claims* to have reserved but has no
   * stock behind — it lost them to a competing claim on the same item, or the stock has since
   * gone. Zero on an ordinary unreserved shortfall, and the signal that this entry is here
   * despite the reservation rather than because none was made.
   */
  readonly unbackedQty: number;
  /** Unit cost used for the estimate (live replacement value when matched). */
  readonly unitCost: number | null;
  /** shortfallQty × unitCost, or null when the unit cost is unknown. */
  readonly estimatedCost: number | null;
}

/**
 * A BOM line currently "In Transit" (spec §4 procurement), joined with its project
 * and matched-item names — the feed for the dashboard "In Transit" tracker that
 * distinguishes parts *arriving soon* from parts simply missing (Phase 9).
 */
export interface InTransitLine {
  readonly lineId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly itemId: string | null;
  /** Display label: matched item name, else the line's free-text description/MPN. */
  readonly label: string;
  readonly requiredQty: number;
  /** Quantity already received in earlier instalments (§4 split receipts, Phase 24). */
  readonly receivedQty: number;
}

// --- Picking worksheet (issue #121, location-aware gather-and-tick) --------------

/**
 * One BOM line resolved into a picking-worksheet row: the line itself (carrying its
 * `picked` flag and required quantity) plus the per-location breakdown of where its
 * matched item's stock physically sits, drawn from the `item_stock` ledger and ordered
 * busiest-location-first. Unmatched lines — or matched items with nothing on hand — carry
 * an empty `placements`, so the worksheet still lists them to gather while showing there
 * is no home location to walk to.
 */
export interface PickLine {
  readonly line: ProjectBomLine;
  /** Where the matched item's units sit, busiest location first; empty when none on hand. */
  readonly placements: readonly ItemStockPlacement[];
}

// --- Assembly finalisation (spec §4 Composite Items & Assemblies) ----------------

export interface FinaliseAssemblyInput {
  /** CONTAINER → new location; SINGULAR_OBJECT → new item; PERMANENT_CONSUMPTION. */
  readonly outcome: AssemblyOutcome;
  /** Name for the resulting container location or singular object item. */
  readonly resultName?: string;
  /** Where the SINGULAR_OBJECT item is placed (defaults to Unassigned). */
  readonly resultLocationId?: string;
}
