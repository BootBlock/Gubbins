/**
 * Pure keyboard maths for the accessible ItemDetailDialog tab rail (spec §3
 * "modern accessible UI components" / §2.4.1 — the WAI-ARIA APG `tabs` pattern,
 * vertical orientation with automatic activation). Kept DOM-free so the
 * navigation logic is unit-tested directly (Protocol Beta), mirroring the
 * `tree-keyboard.ts` / `focus-trap.ts` / `list-window.ts` "extract the logic out
 * of the glue" seam. The DOM glue (roving tabindex, ref focus, selected panel)
 * lives in `ItemDetailDialog.tsx`.
 */

/**
 * Map a key press on a vertical tablist to the tab id that should become focused
 * and selected, given the tab ids in render order and the currently-focused id.
 * Follows the APG vertical-tabs interaction model with automatic activation
 * (moving focus also selects), and wraps at both ends since the set is small and
 * fixed:
 *
 * - **ArrowDown / ArrowRight** — next tab, wrapping from the last back to the first.
 * - **ArrowUp / ArrowLeft** — previous tab, wrapping from the first to the last.
 * - **Home / End** — first / last tab.
 *
 * `null` means "no-op, do not preventDefault". An unknown / stale `focusedId`
 * enters at the first tab on any movement key.
 */
export function resolveTabKey(
  tabIds: readonly string[],
  focusedId: string | null,
  key: string,
): string | null {
  if (tabIds.length === 0) return null;
  const first = tabIds[0]!;
  const last = tabIds[tabIds.length - 1]!;
  const index = tabIds.indexOf(focusedId ?? '');

  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      if (index === -1) return first;
      return tabIds[(index + 1) % tabIds.length]!;

    case 'ArrowUp':
    case 'ArrowLeft':
      if (index === -1) return first;
      return tabIds[(index - 1 + tabIds.length) % tabIds.length]!;

    case 'Home':
      return first;

    case 'End':
      return last;

    default:
      return null;
  }
}
