/**
 * Unified pointer-based drag-to-move for inventory items (spec §4, §5).
 *
 * The shipped drag-to-move was built on native HTML5 drag-and-drop, which never fires on
 * touchscreens — the exact hardware (tablets, wall-mounted kiosks) this app targets. This
 * module replaces it with a single Pointer Events path that behaves identically for mouse,
 * pen and touch: an item card/row is a drag *source*, a location row in the sidebar is a drop
 * *target*, and a floating preview follows the pointer while `document.elementFromPoint`
 * hit-tests the row underneath.
 *
 * Why one path rather than "native for mouse + something for touch": two parallel drag
 * systems fight over the same gestures (`touch-action`, passive listeners, the interactive
 * -origin guard). A single pointer path removes that whole class of bug.
 *
 * Design notes:
 * - **Sources never subscribe to drag state.** They read only the (referentially stable)
 *   {@link ItemDragActionsContext}, so beginning or ending a drag re-renders neither the
 *   virtualised item list nor any card/row — the `memo` on {@link ItemCard}/{@link ItemRow}
 *   stays effective. Only the (small, un-virtualised) sidebar tree re-renders as the active
 *   drop target changes, via {@link ActiveDropContext}.
 * - **Touch disambiguates scroll from drag with a long press.** A touch that moves before the
 *   press delay is a scroll and is left alone; once the drag is armed a non-passive
 *   `touchmove` handler suppresses the browser's scroll so the finger drags instead.
 * - **Auto-scroll is scoped to the sidebar / page, never the item list.** The item list hosts
 *   the drag sources and is virtualised, so scrolling it mid-drag could unmount the very
 *   element a touch pointer is implicitly captured to and abort the gesture. The move target
 *   is always the sidebar, so list auto-scroll isn't needed.
 *
 * This stays an *additive* affordance: the keyboard-accessible "Move item" action
 * ({@link MoveItemDialog}) remains the primary, a11y-complete path.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { isInteractiveDragOrigin } from './item-dnd';

/** Movement (px) after which a mouse/pen press becomes a drag rather than a click. */
const DRAG_ACTIVATE_DISTANCE = 5;
/** How long a touch must stay put before it arms a drag (vs. scrolling the list). */
const TOUCH_LONG_PRESS_MS = 250;
/** Movement (px) during the long-press window that instead resolves the touch as a scroll. */
const TOUCH_CANCEL_DISTANCE = 10;
/** Distance (px) from a scroll container's edge within which a drag auto-scrolls it. */
const AUTOSCROLL_EDGE = 48;
/** Peak auto-scroll speed (px per frame) at the very edge. */
const AUTOSCROLL_MAX_SPEED = 14;
/** Offset (px) of the floating preview from the pointer so it clears the fingertip. */
const PREVIEW_OFFSET = 14;

/** The item being dragged — id to move, name for the floating preview. */
interface DragItem {
  readonly id: string;
  readonly name: string;
}

/** Stable actions a source/target uses to drive the drag. Its identity never changes. */
interface ItemDragActions {
  beginDrag(item: DragItem, event: ReactPointerEvent): void;
  registerDropTarget(locationId: string, onDrop: (itemId: string) => void): void;
  unregisterDropTarget(locationId: string): void;
}

const NOOP_ACTIONS: ItemDragActions = {
  beginDrag() {},
  registerDropTarget() {},
  unregisterDropTarget() {},
};

/** Stable drag actions — safe to read without triggering re-renders. */
const ItemDragActionsContext = createContext<ItemDragActions>(NOOP_ACTIONS);
/** The location id currently under the pointer (a valid drop target), or null. */
const ActiveDropContext = createContext<string | null>(null);

/** Mutable per-gesture state, held in a ref so pointer ticks never re-render. */
interface DragState {
  item: DragItem;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** True once the gesture has become a real drag (past threshold / long-press). */
  active: boolean;
  longPressTimer: number | null;
  raf: number | null;
  /** Removes every window listener for this gesture in one `abort()`. */
  listeners: AbortController;
}

/**
 * Props a drag source (item card/row) spreads onto its root element. Reads only the stable
 * actions context, so a source that spreads these never re-renders when a drag starts or ends.
 */
export function useItemDragSource(item: { id: string; name: string }): {
  onPointerDown: (event: ReactPointerEvent) => void;
  onDragStart: (event: ReactDragEvent) => void;
} {
  const { beginDrag } = useContext(ItemDragActionsContext);
  const id = item.id;
  const name = item.name;
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Only the primary mouse button drags; secondary/middle keep their own behaviour.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // A press begun on a control (± stepper, select box, action button) belongs to that
      // control — leave the drag unarmed so its own gesture works.
      if (isInteractiveDragOrigin(event.target)) return;
      beginDrag({ id, name }, event);
    },
    [beginDrag, id, name],
  );
  // Cancel any native HTML drag a descendant (e.g. an <img> thumbnail, selected text) would
  // otherwise start — the pointer path is the only drag system now.
  const onDragStart = useCallback((event: ReactDragEvent) => event.preventDefault(), []);
  return { onPointerDown, onDragStart };
}

/**
 * Register a location row as a drop target and report whether the pointer is currently over
 * it. `onDrop` is called with the dragged item's id when a drag is released here. Omit
 * `onDrop` for rows that can't receive items (the synthetic "All items" row, archived
 * locations) — they then never highlight and never accept a drop.
 */
export function useItemDropTarget(locationId: string, onDrop?: (itemId: string) => void): boolean {
  const { registerDropTarget, unregisterDropTarget } = useContext(ItemDragActionsContext);
  const activeDropId = useContext(ActiveDropContext);
  useLayoutEffect(() => {
    if (!onDrop) return;
    registerDropTarget(locationId, onDrop);
    return () => unregisterDropTarget(locationId);
  }, [locationId, onDrop, registerDropTarget, unregisterDropTarget]);
  return onDrop != null && activeDropId === locationId;
}

/**
 * Owns the live drag: window pointer listeners, hit-testing, the floating preview, touch
 * long-press arming, scroll suppression and edge auto-scroll. Wrap the region containing both
 * the drag sources (the item list) and the drop targets (the location sidebar).
 */
export function ItemDragProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef<DragState | null>(null);
  const dropTargets = useRef(new Map<string, (itemId: string) => void>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  // The one item currently previewed (drives mounting the floating chip). Toggles once per
  // drag, so it doesn't churn on pointer ticks.
  const [previewItem, setPreviewItem] = useState<DragItem | null>(null);
  const [activeDropId, setActiveDropId] = useState<string | null>(null);

  // Resolve the pointer position to a valid drop-target location id (or null). Pure — used
  // both while dragging (to highlight) and on release (to route the drop), so the release path
  // reads live geometry instead of stale state.
  const hitTest = useCallback((x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const row = el instanceof Element ? el.closest<HTMLElement>('[data-tree-id]') : null;
    const id = row?.getAttribute('data-tree-id') ?? null;
    return id != null && dropTargets.current.has(id) ? id : null;
  }, []);

  const positionPreview = useCallback((x: number, y: number) => {
    const el = previewRef.current;
    if (el) el.style.transform = `translate(${x + PREVIEW_OFFSET}px, ${y + PREVIEW_OFFSET}px)`;
  }, []);

  // Edge auto-scroll: nudge whichever scroll container the pointer sits over (typically the
  // sidebar, or the page) when the pointer nears its top/bottom edge. Deliberately skips the
  // virtualised item list (see the module header).
  const autoScrollStep = useCallback(() => {
    const s = stateRef.current;
    if (!s || !s.active) return;
    const scroller = scrollableUnder(s.lastX, s.lastY);
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const fromTop = s.lastY - rect.top;
      const fromBottom = rect.bottom - s.lastY;
      if (fromTop < AUTOSCROLL_EDGE) scroller.scrollTop -= edgeSpeed(AUTOSCROLL_EDGE - fromTop);
      else if (fromBottom < AUTOSCROLL_EDGE) scroller.scrollTop += edgeSpeed(AUTOSCROLL_EDGE - fromBottom);
    }
    s.raf = requestAnimationFrame(autoScrollStep);
  }, []);

  const endGesture = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    if (s.longPressTimer != null) clearTimeout(s.longPressTimer);
    if (s.raf != null) cancelAnimationFrame(s.raf);
    s.listeners.abort(); // removes pointermove/up/cancel + touchmove in one shot
    if (s.active) {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // A drag that ends over a treeitem would otherwise fire a click and *select* that
      // location. Swallow the one click the release generates (capture phase, before the
      // treeitem sees it); clean the guard up shortly after in case no click follows.
      const swallow = (event: Event) => event.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 350);
    }
    stateRef.current = null;
    setPreviewItem(null);
    setActiveDropId(null);
  }, []);

  // Promote an armed press to a live drag: mount the preview, suppress scroll/selection and
  // start auto-scroll + hit-testing.
  const activateDrag = useCallback(() => {
    const s = stateRef.current;
    if (!s || s.active) return;
    s.active = true;
    if (s.longPressTimer != null) {
      clearTimeout(s.longPressTimer);
      s.longPressTimer = null;
    }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    if (s.pointerType === 'touch') {
      window.addEventListener('touchmove', (e) => e.preventDefault(), {
        passive: false,
        signal: s.listeners.signal,
      });
    }
    setPreviewItem(s.item);
    setActiveDropId(hitTest(s.lastX, s.lastY));
    if (typeof requestAnimationFrame === 'function') s.raf = requestAnimationFrame(autoScrollStep);
  }, [autoScrollStep, hitTest]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s || event.pointerId !== s.pointerId) return;
      s.lastX = event.clientX;
      s.lastY = event.clientY;
      if (!s.active) {
        const distance = Math.hypot(event.clientX - s.startX, event.clientY - s.startY);
        if (s.pointerType === 'touch') {
          // Moving before the long press means the user meant to scroll — let go so the
          // native scroll runs.
          if (distance > TOUCH_CANCEL_DISTANCE) endGesture();
        } else if (distance > DRAG_ACTIVATE_DISTANCE) {
          activateDrag();
        }
        return;
      }
      positionPreview(event.clientX, event.clientY);
      const next = hitTest(event.clientX, event.clientY);
      setActiveDropId((prev) => (prev === next ? prev : next));
    },
    [activateDrag, endGesture, hitTest, positionPreview],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s || event.pointerId !== s.pointerId) return;
      const dropId = s.active ? hitTest(event.clientX, event.clientY) : null;
      const itemId = s.item.id;
      endGesture();
      if (dropId) dropTargets.current.get(dropId)?.(itemId);
    },
    [endGesture, hitTest],
  );

  const onPointerCancel = useCallback(
    (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s || event.pointerId !== s.pointerId) return;
      endGesture();
    },
    [endGesture],
  );

  const beginDrag = useCallback(
    (item: DragItem, event: ReactPointerEvent) => {
      if (stateRef.current) return;
      const listeners = new AbortController();
      const { signal } = listeners;
      stateRef.current = {
        item,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        longPressTimer: null,
        raf: null,
        listeners,
      };
      window.addEventListener('pointermove', onPointerMove, { signal });
      window.addEventListener('pointerup', onPointerUp, { signal });
      window.addEventListener('pointercancel', onPointerCancel, { signal });
      // Touch can't tell drag from scroll up front, so it arms on a stationary long press.
      // Mouse/pen arm on the first few pixels of movement, preserving plain clicks.
      if (event.pointerType === 'touch') {
        stateRef.current.longPressTimer = window.setTimeout(activateDrag, TOUCH_LONG_PRESS_MS);
      }
    },
    [activateDrag, onPointerCancel, onPointerMove, onPointerUp],
  );

  const registerDropTarget = useCallback((locationId: string, onDrop: (itemId: string) => void) => {
    dropTargets.current.set(locationId, onDrop);
  }, []);
  const unregisterDropTarget = useCallback((locationId: string) => {
    dropTargets.current.delete(locationId);
  }, []);

  const actions = useMemo<ItemDragActions>(
    () => ({ beginDrag, registerDropTarget, unregisterDropTarget }),
    [beginDrag, registerDropTarget, unregisterDropTarget],
  );

  // Position the freshly-mounted preview at the current pointer before the browser paints, so
  // it never flashes at the origin.
  useLayoutEffect(() => {
    const s = stateRef.current;
    if (previewItem && s) positionPreview(s.lastX, s.lastY);
  }, [previewItem, positionPreview]);

  return (
    <ItemDragActionsContext.Provider value={actions}>
      <ActiveDropContext.Provider value={activeDropId}>
        {children}
        {previewItem
          ? createPortal(
              <div
                ref={previewRef}
                aria-hidden="true"
                data-testid="item-drag-preview"
                className="pointer-events-none fixed left-0 top-0 z-[80] max-w-[16rem] truncate rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-lg"
              >
                {previewItem.name}
              </div>,
              document.body,
            )
          : null}
      </ActiveDropContext.Provider>
    </ItemDragActionsContext.Provider>
  );
}

/** Auto-scroll speed ramping from 0 at the edge threshold to the peak at the very edge. */
function edgeSpeed(depth: number): number {
  return Math.ceil((Math.min(depth, AUTOSCROLL_EDGE) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_SPEED);
}

/**
 * The nearest vertically-scrollable ancestor of the point, or null. Skips the virtualised
 * item list (whose rows host the drag sources) so auto-scroll can never unmount the element a
 * touch drag is captured to — see the module header.
 */
function scrollableUnder(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y);
  while (el instanceof HTMLElement) {
    if (el.dataset.testid === 'item-list-scroll') return null;
    if (el.scrollHeight > el.clientHeight) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return el;
    }
    el = el.parentElement;
  }
  return null;
}
