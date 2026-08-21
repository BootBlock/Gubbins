/**
 * Undo seam for reversible item writes (issue #131).
 *
 * A bulk edit, a remove, or a move can be reversed — the data model already supports every
 * inverse (`update` / `move` / `restore` / `softDelete` / `TagRepository.setForItem`) — but
 * until now nothing captured *what to reverse to*. This module is the pure half of that: a
 * snapshot of the fields a write is about to overwrite, folded into an {@link UndoPlan} of
 * per-item inverse values. The mutation hook (`useUndoItemChanges`) replays the plan through
 * the very same repository methods the forward write used, so there is **no new write SQL**.
 *
 * Kept React-free and out of the glue (house pattern) so the interesting decision — *which*
 * fields a given item actually needs restoring, and which were already at the target value —
 * is unit-tested in isolation.
 */
import type { Item } from '@/db/repositories';
import type { Condition } from '@/db/repositories/constants';
import { resolveItemTagNames, type BulkEditSpec } from './bulk-edit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The pre-write state of one item, limited to the fields a bulk edit can touch. `tagNames` is
 * present only when the write changes tags — reading them costs a query per item, so the caller
 * skips it when the spec leaves tags alone.
 */
export interface ItemUndoSnapshot {
  readonly id: string;
  readonly categoryId: string | null;
  readonly locationId: string;
  readonly condition: Condition | null;
  readonly isActive: boolean;
  readonly tagNames?: readonly string[];
}

/**
 * The inverse of one item's change: the value each altered field must be set back to. Every
 * field is optional and an **absent** field is left alone — the same wrapper-free
 * presence model {@link BulkEditSpec} uses, except a `null` here is itself a restorable value
 * (an item that had no category goes back to having none).
 */
export interface ItemUndoStep {
  readonly id: string;
  readonly categoryId?: string | null;
  readonly locationId?: string;
  readonly condition?: Condition | null;
  readonly isActive?: boolean;
  readonly tagNames?: readonly string[];
}

/** A complete reversal: one step per item that actually changed. */
export interface UndoPlan {
  readonly steps: readonly ItemUndoStep[];
}

/** The plan a write with nothing to reverse hands back. */
export const EMPTY_UNDO_PLAN: UndoPlan = { steps: [] };

/**
 * How long an undo toast stays on screen (ms) — the toast ceiling, so the action is reachable
 * for as long as a passive toast is ever allowed to linger. The length-derived default would
 * give a short message barely five seconds, which is not long enough to notice a mistake and
 * reach for the button.
 */
export const UNDO_TOAST_DURATION_MS = 15_000;

/**
 * Narrow a full item record down to the fields an undo can restore, optionally with the tag
 * names read alongside it. Projecting explicitly — rather than keeping the whole record — is
 * what keeps a plan small enough to hold in a toast closure across a hundred items.
 */
export function snapshotForUndo(item: Item, tagNames?: readonly string[]): ItemUndoSnapshot {
  return {
    id: item.id,
    categoryId: item.categoryId,
    locationId: item.locationId,
    condition: item.condition,
    isActive: item.isActive,
    ...(tagNames ? { tagNames } : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

/** True when two tag-name lists hold the same names in the same order. */
function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Build the inverse of applying `spec` to the items described by `before`.
 *
 * Only fields the spec actually *changes* are recorded: an item already sitting in the target
 * location, or already carrying the tags being added, contributes nothing — so replaying the
 * plan writes (and logs in the Activity Log) exactly the rows the forward edit touched, no
 * more. An item whose every field was already at the target value is dropped entirely.
 */
export function planBulkEditUndo(spec: BulkEditSpec, before: readonly ItemUndoSnapshot[]): UndoPlan {
  const steps: ItemUndoStep[] = [];
  for (const snap of before) {
    let step: ItemUndoStep = { id: snap.id };
    let changed = false;

    if (spec.category && spec.category.value !== snap.categoryId) {
      step = { ...step, categoryId: snap.categoryId };
      changed = true;
    }
    if (spec.location && spec.location.value !== snap.locationId) {
      step = { ...step, locationId: snap.locationId };
      changed = true;
    }
    if (spec.condition && spec.condition.value !== snap.condition) {
      step = { ...step, condition: snap.condition };
      changed = true;
    }
    if (spec.active && spec.active.value !== snap.isActive) {
      step = { ...step, isActive: snap.isActive };
      changed = true;
    }
    if (spec.tags && spec.tags.names.length > 0 && snap.tagNames) {
      const next = resolveItemTagNames(snap.tagNames, spec.tags);
      if (!sameNames(next, snap.tagNames)) {
        step = { ...step, tagNames: snap.tagNames };
        changed = true;
      }
    }

    if (changed) steps.push(step);
  }
  return { steps };
}

/**
 * The inverse of moving one item out of `fromLocationId`.
 *
 * The origin is optional because the drag payload carries it optionally: a card rendered
 * without a location can still be dragged, and there is then nowhere to put it back. That
 * yields an empty plan, and the caller shows a plain confirmation with no undo offered.
 */
export function planMoveUndo(itemId: string, fromLocationId: string | undefined): UndoPlan {
  return fromLocationId ? { steps: [{ id: itemId, locationId: fromLocationId }] } : EMPTY_UNDO_PLAN;
}

/** The inverse of removing one item from active inventory (a reversible soft-delete). */
export function planRemoveUndo(itemId: string): UndoPlan {
  return { steps: [{ id: itemId, isActive: true }] };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** True when the plan would restore nothing — the caller then offers no undo affordance. */
export function isUndoPlanEmpty(plan: UndoPlan): boolean {
  return plan.steps.length === 0;
}
