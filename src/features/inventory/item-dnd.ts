/**
 * Shared guard for the inventory drag-to-move gesture (spec §4, §5).
 *
 * The live drag machinery (pointer tracking, hit-testing, the floating preview, touch
 * long-press and auto-scroll) lives in {@link ItemDragProvider} in `item-drag.tsx`. This
 * module holds only the one pure predicate both a source and a test can reuse without pulling
 * in React.
 */

/**
 * Whether a press started on an interactive descendant of a draggable card/row (a button,
 * form control or link) — in which case the drag should be suppressed so the control keeps
 * its own behaviour (a ± tap, typing an exact quantity, ticking the select box) rather than
 * dragging the whole item.
 */
export function isInteractiveDragOrigin(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, input, textarea, select, a, [role="button"], [contenteditable="true"]') !== null
  );
}
