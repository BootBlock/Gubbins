/**
 * Guided stock-take / audit-day session maths (spec §4.4), kept pure and DOM-free —
 * mirroring the `cycle-count.ts` / `list-window.ts` "extract the logic out of the glue"
 * seam so the whole thing is unit-tested in isolation, with no clock and no React.
 *
 * The single-location {@link module:cycle-count} module reconciles ONE location. This
 * layer sits above it: given an ordered **scope** (a list of locations to walk) and the
 * per-location outcome recorded as the auditor works, it derives the walk's progress
 * (done / remaining / current / next), a running variance rollup, and the terminal
 * "complete" state. The transient per-location counts stay in `CycleCountProvider`; this
 * seam only tracks cross-location progress, and every function here is a pure projection
 * or an immutable reducer over {@link AuditSessionState}.
 */

import { isPlainObject, normaliseInteger, normaliseOneOf } from '@/lib/persisted-state';

/**
 * How a single location in the scope has been dealt with:
 *
 * - `pending` — not yet finished: still to walk, or currently open.
 * - `counted` — counted in full with nothing left to authorise (a clean count, or no
 *   countable stock).
 * - `reconciled` — counted in full, variances found, and their adjustments authorised.
 * - `partial` — finished with lines left blank (issue #637). Any adjustments for the lines
 *   that *were* counted are applied, but the location is not claimed as audited and its
 *   durable last-counted date is left alone, so it stays on the list of shelves to check.
 * - `skipped` — deliberately skipped by the auditor: done, but not counted.
 */
export const AUDIT_LOCATION_STATUSES = ['pending', 'counted', 'reconciled', 'partial', 'skipped'] as const;

export type AuditLocationStatus = (typeof AUDIT_LOCATION_STATUSES)[number];

/** A location the walk visits, in the order it will be visited. */
export interface AuditScopeLocation {
  readonly id: string;
  readonly name: string;
}

/** The recorded outcome for one location once the auditor has acted on it. */
export interface AuditLocationRecord {
  readonly status: AuditLocationStatus;
  /**
   * How many variance lines were found here — discrete drift lines plus missing
   * serialised instances. Zero for a clean or skipped location.
   */
  readonly variancesFound: number;
  /** How many reconciliation adjustments were actually written to the ledger. */
  readonly adjustmentsMade: number;
}

/**
 * The whole persisted session: the ordered scope, where the walk currently sits, and
 * the per-location records accumulated so far. Everything needed to resume a half-done
 * audit after a reload lives here (the store persists exactly this shape).
 */
export interface AuditSessionState {
  readonly scope: readonly AuditScopeLocation[];
  /** Index into `scope` of the location currently being walked. */
  readonly currentIndex: number;
  /** Per-location outcome, keyed by location id. A missing id means `pending`. */
  readonly records: Readonly<Record<string, AuditLocationRecord>>;
}

/**
 * The variance/adjustment counts recorded when a location is finished. Both optional so a
 * clean count or a skip needs only the status; {@link AuthoriseResult} (all fields
 * present) is assignable to it.
 */
export interface AuditTotals {
  readonly variancesFound?: number;
  readonly adjustmentsMade?: number;
}

/** A location record's default before the auditor has touched it. */
const PENDING_RECORD: AuditLocationRecord = { status: 'pending', variancesFound: 0, adjustmentsMade: 0 };

/**
 * True for the statuses that count as "dealt with" (no longer remaining).
 *
 * @internal Exported for unit tests only.
 */
export function isTerminal(status: AuditLocationStatus): boolean {
  return status !== 'pending';
}

/**
 * The record for a location id, falling back to the pending default.
 *
 * @internal Exported for unit tests only.
 */
export function recordFor(state: AuditSessionState, id: string): AuditLocationRecord {
  return state.records[id] ?? PENDING_RECORD;
}

/**
 * The status of a location id (pending when never recorded).
 *
 * @internal Exported for unit tests only.
 */
export function statusOf(state: AuditSessionState, id: string): AuditLocationStatus {
  return recordFor(state, id).status;
}

// --- Constructing & mutating the session (immutable reducers) -------------------

/**
 * Begin a session over an ordered scope. The walk starts at the first location; no
 * records exist yet (every location is implicitly `pending`).
 */
export function startAudit(scope: readonly AuditScopeLocation[]): AuditSessionState {
  return { scope, currentIndex: 0, records: {} };
}

/**
 * Record an outcome for a location, returning a new state (the input is never mutated).
 * `variancesFound` / `adjustmentsMade` default to 0 so a clean count or a skip needs
 * only the status.
 */
export function markLocation(
  state: AuditSessionState,
  id: string,
  status: AuditLocationStatus,
  totals: AuditTotals = {},
): AuditSessionState {
  return {
    ...state,
    records: {
      ...state.records,
      [id]: {
        status,
        variancesFound: totals.variancesFound ?? 0,
        adjustmentsMade: totals.adjustmentsMade ?? 0,
      },
    },
  };
}

/**
 * Move the walk to a specific index, clamped into `[0, scope.length - 1]`.
 *
 * @internal Exported for unit tests only.
 */
export function goToIndex(state: AuditSessionState, index: number): AuditSessionState {
  if (state.scope.length === 0) return { ...state, currentIndex: 0 };
  const clamped = Math.min(Math.max(index, 0), state.scope.length - 1);
  return { ...state, currentIndex: clamped };
}

/**
 * The index of the next location that still needs doing, searching forward from
 * `fromIndex + 1` and then wrapping to the start (so a location left pending earlier in
 * the walk is picked up again once everything after it is done). Returns `-1` when no
 * location remains pending — i.e. the session is complete.
 *
 * @internal Exported for unit tests only.
 */
export function nextPendingIndex(state: AuditSessionState, fromIndex: number): number {
  const n = state.scope.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIndex + step) % n;
    if (statusOf(state, state.scope[i]!.id) === 'pending') return i;
  }
  return -1;
}

/**
 * The first still-pending index anywhere in the scope, or `-1` when none remain.
 *
 * @internal Exported for unit tests only.
 */
export function firstPendingIndex(state: AuditSessionState): number {
  const i = state.scope.findIndex((loc) => statusOf(state, loc.id) === 'pending');
  return i;
}

/**
 * Advance the walk to the next pending location after the current one. When none
 * remain, the index is left where it is (the caller shows the summary once
 * {@link progress} reports `isComplete`).
 */
export function advance(state: AuditSessionState): AuditSessionState {
  const next = nextPendingIndex(state, state.currentIndex);
  return next === -1 ? state : goToIndex(state, next);
}

/**
 * On resume, land the walk on the first location still needing work. A complete
 * session (nothing pending) is returned unchanged so the caller shows its summary.
 */
export function resumeAt(state: AuditSessionState): AuditSessionState {
  const first = firstPendingIndex(state);
  return first === -1 ? state : goToIndex(state, first);
}

// --- Derived projections (read-only views over the state) ----------------------

/** The walk's progress at a glance. */
export interface AuditProgress {
  /** Total locations in scope. */
  readonly total: number;
  /** Locations with a terminal status (counted / reconciled / partial / skipped). */
  readonly done: number;
  /** Locations still pending. */
  readonly remaining: number;
  /** Current index into the scope. */
  readonly currentIndex: number;
  /** The location currently being walked, or null when the scope is empty. */
  readonly current: AuditScopeLocation | null;
  /** The next pending location to walk after the current one, or null when none. */
  readonly next: AuditScopeLocation | null;
  /** 1-based position for display ("Location {position} of {total}"). */
  readonly position: number;
  /** Fraction complete in `[0, 1]` (0 for an empty scope). */
  readonly fraction: number;
  /** Every location has been dealt with. */
  readonly isComplete: boolean;
}

/** Derive the walk's progress from the session state. */
export function progress(state: AuditSessionState): AuditProgress {
  const total = state.scope.length;
  const done = state.scope.reduce((acc, loc) => acc + (isTerminal(statusOf(state, loc.id)) ? 1 : 0), 0);
  const current = state.scope[state.currentIndex] ?? null;
  const nextIndex = nextPendingIndex(state, state.currentIndex);
  const next = nextIndex === -1 ? null : (state.scope[nextIndex] ?? null);
  return {
    total,
    done,
    remaining: total - done,
    currentIndex: state.currentIndex,
    current,
    next,
    position: total === 0 ? 0 : state.currentIndex + 1,
    fraction: total === 0 ? 0 : done / total,
    isComplete: total > 0 && done === total,
  };
}

/** The terminal roll-up shown when the walk is complete (or as a running tally). */
export interface AuditSummary {
  /**
   * Locations counted in full (clean or reconciled) — i.e. actually audited. A part-counted
   * or skipped location is deliberately excluded: this tile is the walk's claim about how
   * much of the inventory was genuinely verified, so it must not absorb either (issue #637).
   */
  readonly locationsAudited: number;
  /** Locations finished with lines left blank. */
  readonly locationsPartial: number;
  /** Locations the auditor skipped. */
  readonly locationsSkipped: number;
  /** Locations where at least one variance was found. */
  readonly locationsWithVariances: number;
  /** Total variance lines found across the whole walk. */
  readonly totalVariancesFound: number;
  /** Total reconciliation adjustments written across the whole walk. */
  readonly totalAdjustmentsMade: number;
  /** The scope locations that were skipped (in walk order), for the summary list. */
  readonly skipped: readonly AuditScopeLocation[];
  /** The scope locations left part-counted (in walk order), for the summary list. */
  readonly partial: readonly AuditScopeLocation[];
  /** The scope locations that had variances (in walk order), for the summary list. */
  readonly withVariances: readonly AuditScopeLocation[];
}

/** Roll the per-location records up into the audit summary. */
export function summarise(state: AuditSessionState): AuditSummary {
  let locationsAudited = 0;
  let locationsSkipped = 0;
  let totalVariancesFound = 0;
  let totalAdjustmentsMade = 0;
  const skipped: AuditScopeLocation[] = [];
  const partial: AuditScopeLocation[] = [];
  const withVariances: AuditScopeLocation[] = [];

  for (const loc of state.scope) {
    const record = recordFor(state, loc.id);
    if (record.status === 'counted' || record.status === 'reconciled') locationsAudited++;
    if (record.status === 'partial') partial.push(loc);
    if (record.status === 'skipped') {
      locationsSkipped++;
      skipped.push(loc);
    }
    if (record.variancesFound > 0) withVariances.push(loc);
    totalVariancesFound += record.variancesFound;
    totalAdjustmentsMade += record.adjustmentsMade;
  }

  return {
    locationsAudited,
    locationsPartial: partial.length,
    locationsSkipped,
    locationsWithVariances: withVariances.length,
    totalVariancesFound,
    totalAdjustmentsMade,
    skipped,
    partial,
    withVariances,
  };
}

// --- Building a scope from the location tree ------------------------------------

/**
 * The minimal nested-node shape {@link collectAuditableInOrder} needs. Generic over any
 * self-referential tree node (the app's `LocationTreeNode` satisfies it) so the scope
 * maths stays decoupled from the repository types and is trivially unit-testable.
 */
export interface AuditTreeNode {
  readonly id: string;
  readonly name: string;
  /** System-locked rows ("Unassigned", "In Transit") — never part of a physical walk. */
  readonly isSystem?: boolean;
  /** Archived branches are hidden from the walk (mirrors the sidebar's pruning). */
  readonly archivedAt?: number | null;
  readonly children: readonly AuditTreeNode[];
}

/**
 * Every walkable location in depth-first pre-order (the order the sidebar renders), so a
 * scope follows the physical hierarchy. System-locked and archived locations — and, for
 * an archived branch, its whole subtree — are dropped: they are not places an auditor
 * walks with a clipboard.
 *
 * @internal Exported for unit tests only.
 */
export function collectAuditableInOrder(tree: readonly AuditTreeNode[]): AuditScopeLocation[] {
  const out: AuditScopeLocation[] = [];
  const walk = (nodes: readonly AuditTreeNode[]) => {
    for (const node of nodes) {
      if (node.archivedAt) continue; // skip the archived branch and everything beneath it
      if (!node.isSystem) out.push({ id: node.id, name: node.name });
      walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/** How the auditor chose the scope. */
export type AuditScopeMode =
  /** Every walkable location. */
  | 'all'
  /** One anchor location and its whole subtree. */
  | 'subtree'
  /** A hand-picked set of locations. */
  | 'selected';

/**
 * Build the ordered scope for a chosen mode. Always returns locations in tree
 * pre-order regardless of mode, so the walk is predictable:
 * - `all` — every walkable location.
 * - `subtree` — the `anchorId` location and its descendants (empty if the anchor is
 *   itself unwalkable/absent).
 * - `selected` — the walkable locations whose ids are in `selectedIds`, in tree order.
 */
export function buildScope(
  tree: readonly AuditTreeNode[],
  mode: AuditScopeMode,
  options: { anchorId?: string | null; selectedIds?: ReadonlySet<string> } = {},
): AuditScopeLocation[] {
  const all = collectAuditableInOrder(tree);
  if (mode === 'all') return all;
  if (mode === 'selected') {
    const ids = options.selectedIds ?? new Set<string>();
    return all.filter((loc) => ids.has(loc.id));
  }
  // subtree — find the anchor anywhere in the tree, then flatten its own subtree.
  const anchorId = options.anchorId ?? null;
  if (!anchorId) return [];
  const anchor = findNode(tree, anchorId);
  return anchor ? collectAuditableInOrder([anchor]) : [];
}

/** Depth-first search for a node by id in a nested tree (null when absent). */
function findNode(nodes: readonly AuditTreeNode[], id: string): AuditTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

// --- Rehydration -----------------------------------------------------------------

/** Reconcile one persisted scope entry; null when it isn't a usable `{ id, name }` pair. */
function normaliseScopeLocation(value: unknown): AuditScopeLocation | null {
  if (!isPlainObject(value)) return null;
  const { id, name } = value;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null;
  return { id, name };
}

/** Reconcile one persisted per-location record against {@link AuditLocationRecord}. */
function normaliseRecord(value: unknown): AuditLocationRecord {
  if (!isPlainObject(value)) return PENDING_RECORD;
  return {
    status: normaliseOneOf(value.status, AUDIT_LOCATION_STATUSES, 'pending'),
    variancesFound: normaliseInteger(value.variancesFound, 0, { min: 0 }),
    adjustmentsMade: normaliseInteger(value.adjustmentsMade, 0, { min: 0 }),
  };
}

/**
 * Reconcile a session rehydrated from `localStorage` back into a valid
 * {@link AuditSessionState}, or `null` when nothing resumable survives.
 *
 * Persisted JSON is untyped (see `lib/persisted-state`), and every function in this seam
 * indexes `scope` by `currentIndex` and dereferences `scope[i].id` — so a truncated write, a
 * hand-edit, or a shape from an older release would throw rather than degrade. Scope entries
 * that aren't a usable `{ id, name }` pair are dropped, duplicate ids collapse to their first
 * occurrence (the walk visits each location once), `currentIndex` is clamped into range, and
 * records for ids no longer in scope are discarded. An empty scope has nothing to walk, so it
 * reconciles to "no session" rather than an unresumable one.
 */
export function normaliseAuditSession(value: unknown): AuditSessionState | null {
  if (!isPlainObject(value)) return null;

  const seen = new Set<string>();
  const scope: AuditScopeLocation[] = [];
  for (const entry of Array.isArray(value.scope) ? value.scope : []) {
    const location = normaliseScopeLocation(entry);
    if (!location || seen.has(location.id)) continue;
    seen.add(location.id);
    scope.push(location);
  }
  if (scope.length === 0) return null;

  const persistedRecords = isPlainObject(value.records) ? value.records : {};
  const records: Record<string, AuditLocationRecord> = {};
  for (const location of scope) {
    // Only ids still in scope are kept — a stale record can't affect progress, and carrying
    // it would let a removed location count towards `done`. `hasOwnProperty`, not `in`, so an
    // id colliding with an `Object.prototype` key can't conjure a record that was never stored.
    if (Object.prototype.hasOwnProperty.call(persistedRecords, location.id)) {
      records[location.id] = normaliseRecord(persistedRecords[location.id]);
    }
  }

  return {
    scope,
    currentIndex: normaliseInteger(value.currentIndex, 0, { min: 0, max: scope.length - 1 }),
    records,
  };
}
