/**
 * Bulk-edit pure seam (Phase 76, third feature-gap audit candidate #3).
 *
 * The inventory list already has multi-select for label printing and the scanner "move all";
 * this adds **field bulk-edit** — set category / location / condition / active-state / tags
 * across many selected items at once. The logic lives here, out of the glue (house pattern): a
 * `BulkEditSpec` describing *which* fields change and to *what*, normalised and summarised by
 * pure, unit-tested functions. The mutation hook reads the spec and applies each change through
 * the existing, already-tested repository methods (`update` / `move` / `softDelete` / `restore` /
 * `TagRepository.setForItem`) — so there is **no new write SQL and no schema change**.
 *
 * **Wrapper-presence model.** Each field is an optional *wrapper* object. Its presence means
 * "change this field"; its `value` carries the new value (which may itself be `null`, e.g.
 * clear the category). This cleanly distinguishes "set to None" from "leave unchanged" — a plain
 * optional `categoryId?: string | null` could not.
 */
import type { Condition } from '@/db/repositories/constants';

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/** How a tag change is applied: merge into the existing set, or replace it wholesale. */
export type TagEditMode = 'add' | 'replace';

/**
 * A bulk-edit request. Every field is optional; an **absent** field is left untouched. A
 * **present** field (even one whose `value` is `null`) is applied to every selected item.
 */
export interface BulkEditSpec {
  /** Set the category (`null` clears it back to uncategorised). */
  readonly category?: { readonly value: string | null };
  /** Move every item to this location id. */
  readonly location?: { readonly value: string };
  /** Set the operational condition (`null` clears it back to untracked). */
  readonly condition?: { readonly value: Condition | null };
  /** Set the active-state: `true` = active/restored, `false` = removed (soft-deleted). */
  readonly active?: { readonly value: boolean };
  /** Add to, or replace, each item's tag set. */
  readonly tags?: { readonly mode: TagEditMode; readonly names: readonly string[] };
}

// ---------------------------------------------------------------------------
// Emptiness
// ---------------------------------------------------------------------------

/**
 * True when the spec would change nothing — no field selected, or a tag change with no names.
 * The dialog uses this to disable "Apply".
 */
export function isBulkEditEmpty(spec: BulkEditSpec): boolean {
  if (spec.category || spec.location || spec.condition || spec.active) return false;
  if (spec.tags && spec.tags.names.length > 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tag input parsing & resolution
// ---------------------------------------------------------------------------

/** Split a comma-separated tag input into trimmed, non-empty names (order preserved). */
export function parseTagInput(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Resolve the final tag-name set for one item given its current tags and the tag edit:
 * - `add`     — the current names plus the new ones (deduped case-insensitively, current first).
 * - `replace` — exactly the new names (deduped case-insensitively).
 *
 * Deduping keeps the first-seen casing. `TagRepository.setForItem` re-normalises too, but this
 * is unit-tested in isolation and lets the caller preview the result.
 */
export function resolveItemTagNames(
  currentNames: readonly string[],
  tags: { readonly mode: TagEditMode; readonly names: readonly string[] },
): string[] {
  const source = tags.mode === 'add' ? [...currentNames, ...tags.names] : [...tags.names];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

/** Name lookups the summary uses to render ids as readable labels. */
export interface BulkEditLookups {
  /** Category id → display name (absent ⇒ falls back to the id). */
  readonly categoryName: (id: string) => string;
  /** Location id → display name (absent ⇒ falls back to the id). */
  readonly locationName: (id: string) => string;
  /** Condition enum → display label. */
  readonly conditionLabel: (c: Condition) => string;
}

/**
 * One human-readable line per field the spec changes (e.g. `Category → Resistors`,
 * `Condition → cleared`, `Tags → add 2`). Empty when the spec changes nothing. Drives the
 * confirm summary and the aria-live announcement.
 */
export function summariseBulkEdit(spec: BulkEditSpec, lookups: BulkEditLookups): string[] {
  const lines: string[] = [];
  if (spec.category) {
    lines.push(
      `Category → ${spec.category.value === null ? 'cleared' : lookups.categoryName(spec.category.value)}`,
    );
  }
  if (spec.location) {
    lines.push(`Location → ${lookups.locationName(spec.location.value)}`);
  }
  if (spec.condition) {
    lines.push(
      `Condition → ${spec.condition.value === null ? 'cleared' : lookups.conditionLabel(spec.condition.value)}`,
    );
  }
  if (spec.active) {
    lines.push(`State → ${spec.active.value ? 'Active' : 'Removed'}`);
  }
  if (spec.tags && spec.tags.names.length > 0) {
    const verb = spec.tags.mode === 'add' ? 'add' : 'replace with';
    lines.push(`Tags → ${verb} ${spec.tags.names.length}`);
  }
  return lines;
}
