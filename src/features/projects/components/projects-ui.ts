/**
 * Shared British-English display labels for the Phase 4 project enums (spec §4).
 * Kept separate from the constants so the repository/migration layer stays free of
 * UI strings.
 */
import type { CostingMode, ProcurementStatus, ProjectStatus, ReservationStatus } from '@/db/repositories';
import type { BudgetStatus } from '../budget';

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
};

export const COSTING_MODE_LABELS: Record<CostingMode, string> = {
  CURRENT_REPLACEMENT: 'Current replacement value',
  POINT_IN_TIME: 'Point-in-time snapshot',
};

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  NONE: 'Not reserved',
  TENTATIVE: 'Tentative',
  ACTUAL: 'Actually reserved',
};

export const PROCUREMENT_STATUS_LABELS: Record<ProcurementStatus, string> = {
  NONE: 'Not ordered',
  ORDERED: 'Ordered',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
};

export const ASSEMBLY_OUTCOME_LABELS = {
  CONTAINER: 'Container',
  SINGULAR_OBJECT: 'Singular object',
  PERMANENT_CONSUMPTION: 'Permanent consumption',
} as const;

export const ASSEMBLY_OUTCOME_DESCRIPTIONS = {
  CONTAINER: 'The project becomes a location holding its individual parts.',
  SINGULAR_OBJECT: 'The parts merge into one new inventory item; the parts are consumed.',
  PERMANENT_CONSUMPTION: 'The parts are permanently consumed and removed from active tracking.',
} as const;

// --- Budgeting display (spec §4 budgeting) -------------------------------------

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  NONE: 'No budget set',
  OK: 'On track',
  WARN: 'Near budget',
  OVER: 'Over budget',
};

/** Semantic text-colour token per budget status (never a raw colour — CLAUDE.md). */
export const BUDGET_STATUS_TEXT: Record<BudgetStatus, string> = {
  NONE: 'text-muted-foreground',
  OK: 'text-success',
  WARN: 'text-warning',
  OVER: 'text-destructive',
};

/** Semantic fill token for the budget meter bar per status. */
export const BUDGET_STATUS_FILL: Record<BudgetStatus, string> = {
  NONE: 'bg-muted-foreground/40',
  OK: 'bg-success',
  WARN: 'bg-warning',
  OVER: 'bg-destructive',
};
