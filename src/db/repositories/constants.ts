/**
 * Shared domain constants for the Phase 2 inventory model (spec §4, §4.1).
 *
 * Kept dependency-free so the v2 migration, the repositories, the TanStack Query
 * hooks and the UI can all share a single source of truth without import cycles.
 */

/**
 * Fixed, well-known identifier for the system-locked **"Unassigned"** location
 * (spec §4). It is a deliberately *constant* UUIDv4 — never `crypto.randomUUID()` —
 * because Phase 7's relational-integrity resolution (§7.5.2) re-parents orphaned
 * items to "the system's default Unassigned location ID", which only works if
 * every device shares one canonical id. A random per-device id would create
 * duplicate Unassigned rows that collide on synchronisation.
 */
export const UNASSIGNED_LOCATION_ID = '00000000-0000-4000-8000-000000000001';

/** Display name of the seeded system location. */
export const UNASSIGNED_LOCATION_NAME = 'Unassigned';

/**
 * Strict RPC pagination ceiling (spec §2.1): repositories must never return
 * unpaginated arrays. Page reads clamp `limit` to this value to keep the worker
 * bridge and the virtualised lists light even with 100,000+ rows.
 */
export const MAX_PAGE_SIZE = 100;

/** Default page size when a caller does not specify one. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Item tracking levels (spec §4 "Tracking Levels", §4.1.1).
 * - `DISCRETE` — integer quantity (e.g. screws).
 * - `SERIALISED` — quantity forced to 1; cloning is a Phase 3 deliverable.
 * - `CONSUMABLE_GAUGE` — continuously degrading material tracked by net value.
 */
export const TRACKING_MODES = ['DISCRETE', 'SERIALISED', 'CONSUMABLE_GAUGE'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/**
 * Immutable Activity Log action types (spec §4 "Activity Log", §4.1.3). The set
 * is intentionally small for Phase 2; later phases append (never repurpose) values.
 */
export const HISTORY_ACTIONS = [
  'CREATED',
  'RENAMED',
  'QUANTITY_CHANGE',
  'GAUGE_UPDATE',
  'MOVED',
  'SOFT_DELETED',
  'RESTORED',
  'RE_PARENTED',
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
