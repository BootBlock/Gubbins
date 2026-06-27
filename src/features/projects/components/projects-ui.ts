/**
 * Shared British-English display labels for the Phase 4 project enums (spec §4).
 * Kept separate from the constants so the repository/migration layer stays free of
 * UI strings.
 */
import type {
  CostingMode,
  ProcurementStatus,
  ProjectStatus,
  ReservationStatus,
} from '@/db/repositories';

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
