/**
 * Pure keyboard maths for the accessible LocationSidebar tree (spec §3 "modern
 * accessible UI components" / §2.4.1 — the WAI-ARIA APG `tree` pattern). Kept
 * DOM-free so the navigation logic is unit-tested directly (Protocol Beta),
 * mirroring the Phase-38 `focus-trap.ts` and the `list-window.ts` / `cycle-count.ts`
 * "extract the logic out of the glue" seam. The DOM glue (roving tabindex, ref
 * focus, expand/collapse state, selection, delete confirmation) lives in
 * `useLocationSidebar.ts`.
 */

/** One *visible* tree row, in render order (descendants of collapsed nodes omitted). */
export interface TreeRow {
  readonly id: string;
  /** 1-based depth, surfaced as `aria-level`. */
  readonly level: number;
  /** Whether the node has children (drives `aria-expanded` and ArrowRight/Left). */
  readonly expandable: boolean;
  /** Whether the node is currently expanded. */
  readonly expanded: boolean;
  /** Whether the node may be deleted (the system "Unassigned" location may not). */
  readonly deletable: boolean;
}

/** The instruction a key press resolves to; `null` means "no-op, do not preventDefault". */
export type TreeKeyAction =
  | { readonly kind: 'focus'; readonly id: string }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'collapse'; readonly id: string }
  | { readonly kind: 'select'; readonly id: string }
  | { readonly kind: 'edit'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string };

/**
 * Map a key press on the tree to the action it should perform, given the flattened
 * visible rows and the currently-focused row id. Follows the APG vertical
 * single-select tree interaction model:
 *
 * - **ArrowDown / ArrowUp** — move focus to the next / previous visible row (no wrap).
 * - **Home / End** — focus the first / last visible row.
 * - **ArrowRight** — expand a collapsed parent; on an already-expanded parent, move
 *   focus to its first child; a no-op on a leaf.
 * - **ArrowLeft** — collapse an expanded parent; otherwise move focus to the parent
 *   row (the nearest preceding row at a shallower level); a no-op at the root.
 * - **Enter / Space** — select (activate) the focused row.
 * - **F2** — begin an inline rename of the focused row, when it is mutable. (A
 *   system location such as "Unassigned" is immutable; `deletable` doubles as the
 *   "not system-locked" predicate, since both reduce to `!isSystem`.)
 * - **Delete** — delete the focused row, when it is deletable.
 *
 * An unknown / stale `focusedId` enters at the first row on a movement key.
 */
export function resolveTreeKey(
  rows: readonly TreeRow[],
  focusedId: string | null,
  key: string,
): TreeKeyAction | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;

  const index = rows.findIndex((r) => r.id === focusedId);
  const current = index === -1 ? null : rows[index]!;

  switch (key) {
    case 'ArrowDown':
      if (!current) return { kind: 'focus', id: first.id };
      return index >= rows.length - 1 ? null : { kind: 'focus', id: rows[index + 1]!.id };

    case 'ArrowUp':
      if (!current) return { kind: 'focus', id: first.id };
      return index <= 0 ? null : { kind: 'focus', id: rows[index - 1]!.id };

    case 'Home':
      return { kind: 'focus', id: first.id };

    case 'End':
      return { kind: 'focus', id: last.id };

    case 'ArrowRight':
      if (!current) return { kind: 'focus', id: first.id };
      if (!current.expandable) return null;
      if (!current.expanded) return { kind: 'expand', id: current.id };
      // Expanded: the next visible row is this node's first child.
      return index >= rows.length - 1 ? null : { kind: 'focus', id: rows[index + 1]!.id };

    case 'ArrowLeft': {
      if (!current) return null;
      if (current.expandable && current.expanded) return { kind: 'collapse', id: current.id };
      // Otherwise step out to the parent: the nearest preceding shallower row.
      for (let j = index - 1; j >= 0; j--) {
        if (rows[j]!.level < current.level) return { kind: 'focus', id: rows[j]!.id };
      }
      return null;
    }

    case 'Enter':
    case ' ':
      return current ? { kind: 'select', id: current.id } : null;

    case 'F2':
      return current && current.deletable ? { kind: 'edit', id: current.id } : null;

    case 'Delete':
      return current && current.deletable ? { kind: 'delete', id: current.id } : null;

    default:
      return null;
  }
}
