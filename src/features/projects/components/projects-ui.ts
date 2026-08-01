/**
 * Shared British-English display labels for the Phase 4 project enums (spec §4).
 * Kept separate from the constants so the repository/migration layer stays free of
 * UI strings.
 */
import type { CostingMode, ProcurementStatus, ProjectStatus, ReservationStatus } from '@/db/repositories';
import type { MessageKey } from '@/features/i18n';
import type { BudgetStatus } from '../budget';

/**
 * The English reference for each status. Surfaces that translate read
 * {@link PROJECT_STATUS_LABEL_KEYS} instead; this stays the base text, held byte-identical to
 * `en.json` by the catalog-drift test.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  ARCHIVED: 'Archived',
};

/** The catalog key carrying each status label, for the surfaces that go through `t()`. */
export const PROJECT_STATUS_LABEL_KEYS: Record<ProjectStatus, MessageKey> = {
  PLANNING: 'projects.status.planning',
  ACTIVE: 'projects.status.active',
  COMPLETED: 'projects.status.completed',
  ARCHIVED: 'projects.status.archived',
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

// Each description says what happens to the *quantities the bill of materials asks for* — only
// those move or are consumed, and a part is archived only when the build takes the last of it
// (issue #647). Wording that promised the whole item would contradict the summary below it.
export const ASSEMBLY_OUTCOME_DESCRIPTIONS = {
  CONTAINER: 'The project becomes a location holding the parts the build used.',
  SINGULAR_OBJECT: 'The parts merge into one new inventory item; the quantities used are consumed.',
  PERMANENT_CONSUMPTION: 'The quantities used are consumed and leave your active stock.',
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
