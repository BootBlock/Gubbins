/**
 * Drag-and-drop glue for moving an inventory item onto a location (spec §4, §5).
 *
 * An item card/row is a drag source that carries the item's id under a private MIME type;
 * a location row in the sidebar is a drop target that reads it back and issues a move. The
 * private type keeps the payload out of the way of ordinary text drops and lets a drop
 * target cheaply detect "is this one of ours?" from `dataTransfer.types` alone (the values
 * are not readable during dragover, only the type list is).
 *
 * This is an *additive* affordance: the keyboard-accessible "Move item" action (the
 * {@link MoveItemDialog}) remains the primary, a11y-complete path — native HTML DnD is
 * pointer-only, so it never becomes the sole way to move an item.
 */

/** Private MIME type carrying the dragged item's id. */
export const ITEM_DND_MIME = 'application/x-gubbins-item-id';

/**
 * Whether a drag started on an interactive descendant of a draggable card/row (a button,
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

/** True when a drag currently in progress is carrying one of our items. */
export function dragCarriesItem(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(ITEM_DND_MIME);
}
