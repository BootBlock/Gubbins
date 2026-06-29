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

// --- Projects (spec §4 "Projects & BOMs", Phase 4) ------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly costing_mode: CostingMode;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly costingMode: CostingMode;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A project plus its denormalised BOM-line count, for the list view. */
export interface ProjectWithCount extends Project {
  readonly lineCount: number;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string | null;
  readonly costingMode?: CostingMode;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly status?: ProjectStatus;
  readonly costingMode?: CostingMode;
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
  /** Quantity still to acquire (required − reserved), summed across merged lines. */
  readonly shortfallQty: number;
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

// --- Assembly finalisation (spec §4 Composite Items & Assemblies) ----------------

export interface FinaliseAssemblyInput {
  /** CONTAINER → new location; SINGULAR_OBJECT → new item; PERMANENT_CONSUMPTION. */
  readonly outcome: AssemblyOutcome;
  /** Name for the resulting container location or singular object item. */
  readonly resultName?: string;
  /** Where the SINGULAR_OBJECT item is placed (defaults to Unassigned). */
  readonly resultLocationId?: string;
}
