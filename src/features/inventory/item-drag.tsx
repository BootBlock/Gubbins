/**
 * Unified pointer-based drag-to-move for the inventory workspace (spec §4, §5).
 *
 * The shipped drag-to-move was built on native HTML5 drag-and-drop, which never fires on
 * touchscreens — the exact hardware (tablets, wall-mounted kiosks) this app targets. This
 * module replaces it with a single Pointer Events path that behaves identically for mouse,
 * pen and touch: a drag *source* (an item card/row, or a location row) is dragged onto a drop
 * *target* (a location row in the sidebar), and a floating preview follows the pointer while
 * `document.elementFromPoint` hit-tests the row underneath.
 *
 * A drag carries a small **payload** with a `kind` (`'item'` | `'location'`), so the one path
 * serves two gestures: dragging an *item* onto a location moves the item there, and dragging a
 * *location* onto another location nests it beneath that parent. Each drop target declares what
 * it `accepts`, so a location can refuse an illegal nest (itself or one of its descendants —
 * §7.5.3) and simply never highlight for it.
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
 * ({@link MoveItemDialog}) and the Edit-location Parent field remain the primary,
 * a11y-complete paths.
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

/**
 * Body class applied while a pointer drag is live. A global CSS rule (src/styles/index.css)
 * forces the `grabbing` cursor across every element while it's set, so the cursor stays the
 * drag cursor instead of flickering to each element's own as the pointer crosses the UI.
 */
const DRAGGING_CLASS = 'gubbins-dragging';
/**
 * Body class applied *additionally* while the pointer is over a drop target that rejects the
 * in-flight drag (an item over its own location, an illegal location nest). Its CSS rule swaps
 * the cursor to `not-allowed`, giving immediate "can't drop here" feedback.
 */
const DRAG_INVALID_CLASS = 'gubbins-drag-invalid';

/** What is being dragged: an inventory item to move, or a location to re-nest. */
export type DragKind = 'item' | 'location';

/** The payload being dragged — id to act on, name for the floating preview. */
export interface DragPayload {
  readonly kind: DragKind;
  readonly id: string;
  readonly name: string;
  /**
   * For an `item` drag: the item's current location id, so a location row can reject a no-op
   * move onto the location the item is already in (the drop shows the forbidden cursor). Unset
   * for `location` drags (their illegal-nest veto is `acceptsLocation`).
   */
  readonly sourceLocationId?: string;
}

/**
 * A registered drop target (a location row). `accepts` gates both the hover highlight and the
 * drop — a target that returns `false` for the current payload never lights up and never
 * receives it. `onDrop` runs the move/nest when a drag is released over an accepting target.
 */
interface DropTarget {
  onDrop(payload: DragPayload): void;
  accepts(payload: DragPayload): boolean;
}

/**
 * Where the pointer sits relative to the tree during a live drag. `overRow` is true whenever the
 * pointer is over a tree row (`[data-tree-id]`) — droppable or not — which is what drives the
 * forbidden cursor: shown over a row that can't take the drop, but never over empty space.
 * `acceptedId` is the row id only when it is a registered target that accepts this drag, and
 * drives both the highlight and the drop.
 */
interface DragHit {
  readonly overRow: boolean;
  readonly acceptedId: string | null;
}

/** Stable actions a source/target uses to drive the drag. Its identity never changes. */
interface ItemDragActions {
  beginDrag(payload: DragPayload, event: ReactPointerEvent): void;
  registerDropTarget(id: string, target: DropTarget): void;
  unregisterDropTarget(id: string): void;
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
  payload: DragPayload;
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
 * Shared source hook: a press on the element begins a drag of the given payload kind. Reads
 * only the stable actions context, so an element that spreads these never re-renders when a
 * drag starts or ends.
 */
function useDragSource(
  kind: DragKind,
  item: { id: string; name: string; sourceLocationId?: string },
): {
  onPointerDown: (event: ReactPointerEvent) => void;
  onDragStart: (event: ReactDragEvent) => void;
} {
  const { beginDrag } = useContext(ItemDragActionsContext);
  const id = item.id;
  const name = item.name;
  const sourceLocationId = item.sourceLocationId;
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Ignore a press that bubbled up from one of the card's own dialogs. Those dialogs (Move,
      // details, Add to project, …) are React children of the drag source, so their pointer
      // events bubble here through the React tree — but they render in a portal *outside* the
      // source's DOM. A genuine press on the card body has its `target` inside `currentTarget`,
      // whereas a press inside an open dialog does not; arming a drag from it would wrongly grab
      // the card and force the global grabbing cursor across the dialog. Same guard the
      // card-click shortcut uses (see `useCardClickAction`).
      if (!event.currentTarget.contains(event.target as Node)) return;
      // Only the primary mouse button drags; secondary/middle keep their own behaviour.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // A press begun on a control (± stepper, select box, action button) belongs to that
      // control — leave the drag unarmed so its own gesture works.
      if (isInteractiveDragOrigin(event.target)) return;
      beginDrag({ kind, id, name, sourceLocationId }, event);
    },
    [beginDrag, kind, id, name, sourceLocationId],
  );
  // Cancel any native HTML drag a descendant (e.g. an <img> thumbnail, selected text) would
  // otherwise start — the pointer path is the only drag system now.
  const onDragStart = useCallback((event: ReactDragEvent) => event.preventDefault(), []);
  return { onPointerDown, onDragStart };
}

/**
 * Props a draggable inventory item (card/row) spreads onto its root element, making it a drag
 * source that moves the item to whichever location row it is released over. The item's current
 * `locationId` rides along so a drop onto that same location is rejected (a no-op move).
 */
export function useItemDragSource(item: { id: string; name: string; locationId?: string }) {
  return useDragSource('item', { id: item.id, name: item.name, sourceLocationId: item.locationId });
}

/**
 * Props a draggable location row spreads onto its root element, making it a drag source that
 * nests the location beneath whichever location row it is released over. Omit on rows that
 * can't be re-nested (the synthetic "All items" row, the system-locked Unassigned/In Transit
 * rows, an archived location).
 */
export function useLocationDragSource(location: { id: string; name: string }) {
  return useDragSource('location', location);
}

/**
 * Register an element as a drop target and report whether the pointer is currently over it
 * *and* it accepts the in-flight drag. Pass `null` for `target` when the row can't currently
 * receive anything (it then never registers and never highlights). The `target` object must be
 * referentially stable across renders (memoise it) so the registration effect doesn't churn.
 */
export function useDropTarget(id: string, target: DropTarget | null): boolean {
  const { registerDropTarget, unregisterDropTarget } = useContext(ItemDragActionsContext);
  const activeDropId = useContext(ActiveDropContext);
  useLayoutEffect(() => {
    if (!target) return;
    registerDropTarget(id, target);
    return () => unregisterDropTarget(id);
  }, [id, target, registerDropTarget, unregisterDropTarget]);
  return target != null && activeDropId === id;
}

/**
 * A location row's drop behaviour: it can receive a dragged **item** (move it here) and/or a
 * dragged **location** (nest it here). It vetoes a no-op / illegal drop so the row neither
 * highlights nor accepts it (and the drag shows the forbidden cursor): an **item** already in
 * this location, or a **location** onto itself or one of its own descendants (§7.5.3, via
 * `acceptsLocation`). Returns whether the row is the active, accepting target under the pointer.
 */
export function useLocationRowDrop(
  id: string,
  handlers: {
    /** Called with the dropped item's id and name (the name lets the caller name it in feedback). */
    onDropItem?: (itemId: string, itemName: string) => void;
    onDropLocation?: (locationId: string) => void;
    acceptsLocation?: (draggedLocationId: string) => boolean;
  },
): boolean {
  const { onDropItem, onDropLocation, acceptsLocation } = handlers;
  const target = useMemo<DropTarget | null>(() => {
    if (!onDropItem && !onDropLocation) return null;
    return {
      accepts: (payload) =>
        payload.kind === 'item'
          ? onDropItem != null && payload.sourceLocationId !== id
          : onDropLocation != null && payload.id !== id && (acceptsLocation?.(payload.id) ?? true),
      onDrop: (payload) => {
        if (payload.kind === 'item') onDropItem?.(payload.id, payload.name);
        else onDropLocation?.(payload.id);
      },
    };
  }, [id, onDropItem, onDropLocation, acceptsLocation]);
  return useDropTarget(id, target);
}

/**
 * Owns the live drag: window pointer listeners, hit-testing, the floating preview, touch
 * long-press arming, scroll suppression and edge auto-scroll. Wrap the region containing both
 * the drag sources (the item list, the location tree) and the drop targets (the location
 * sidebar).
 */
export function ItemDragProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef<DragState | null>(null);
  const dropTargets = useRef(new Map<string, DropTarget>());
  const previewRef = useRef<HTMLDivElement | null>(null);
  // The one payload currently previewed (drives mounting the floating chip). Toggles once per
  // drag, so it doesn't churn on pointer ticks.
  const [previewItem, setPreviewItem] = useState<DragPayload | null>(null);
  const [activeDropId, setActiveDropId] = useState<string | null>(null);

  // Resolve where the pointer sits relative to the tree during a drag. Pure and read from live
  // geometry, so highlight, forbidden-cursor and release routing all agree.
  //  - not over any tree row → empty space (item list, page): a normal drag, never forbidden.
  //  - over a tree row that is a registered target accepting this payload → `acceptedId` = its id
  //    (highlight + drop).
  //  - over any other tree row → `overRow` true but `acceptedId` null: a row that can't take this
  //    drop, whether it vetoes the payload (the item's own location, an illegal nest) or isn't a
  //    drop target at all (the synthetic "All items" filter, an archived location). Either way:
  //    no highlight, no drop, forbidden cursor.
  const resolveTarget = useCallback((x: number, y: number): DragHit => {
    const el = document.elementFromPoint(x, y);
    const row = el instanceof Element ? el.closest<HTMLElement>('[data-tree-id]') : null;
    const id = row?.getAttribute('data-tree-id') ?? null;
    if (id == null) return { overRow: false, acceptedId: null };
    const target = dropTargets.current.get(id);
    const payload = stateRef.current?.payload;
    const accepted = target != null && payload != null && target.accepts(payload);
    return { overRow: true, acceptedId: accepted ? id : null };
  }, []);

  // Toggle the forbidden-cursor body class: set while over a tree row that can't take this drop,
  // cleared over an accepting row or empty space.
  const syncCursor = useCallback((hit: DragHit) => {
    document.body.classList.toggle(DRAG_INVALID_CLASS, hit.overRow && hit.acceptedId == null);
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
      document.body.classList.remove(DRAGGING_CLASS, DRAG_INVALID_CLASS);
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
    document.body.classList.add(DRAGGING_CLASS);
    // The scroll-suppressing `touchmove` listener is bound up-front in `beginDrag` (see there),
    // not here — a non-passive `touchmove` added only once the drag arms is bound too late for a
    // real touch engine to honour, and the finger scrolls the list instead of dragging (#56).
    setPreviewItem(s.payload);
    const hit = resolveTarget(s.lastX, s.lastY);
    setActiveDropId(hit.acceptedId);
    syncCursor(hit);
    if (typeof requestAnimationFrame === 'function') s.raf = requestAnimationFrame(autoScrollStep);
  }, [autoScrollStep, resolveTarget, syncCursor]);

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
      const hit = resolveTarget(event.clientX, event.clientY);
      const next = hit.acceptedId;
      setActiveDropId((prev) => (prev === next ? prev : next));
      syncCursor(hit);
    },
    [activateDrag, endGesture, resolveTarget, syncCursor, positionPreview],
  );

  const onPointerUp = useCallback(
    (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s || event.pointerId !== s.pointerId) return;
      const dropId = s.active ? resolveTarget(event.clientX, event.clientY).acceptedId : null;
      const payload = s.payload;
      endGesture();
      if (dropId) dropTargets.current.get(dropId)?.onDrop(payload);
    },
    [endGesture, resolveTarget],
  );

  const onPointerCancel = useCallback(
    (event: PointerEvent) => {
      const s = stateRef.current;
      if (!s || event.pointerId !== s.pointerId) return;
      endGesture();
    },
    [endGesture],
  );

  // Suppress the browser's native touch-scroll *only* once a drag has armed, so the finger drags
  // the card instead of scrolling the list. Bound at pointer-down (touchstart) so the browser
  // treats the gesture's `touchmove` as cancelable; a listener added later — when the long press
  // fires — is honoured on desktop but not on real touch engines, which have already begun
  // resolving the touch as a scroll by then (#56). Until the drag arms it does nothing, so a
  // pre-arm move still scrolls normally.
  const suppressTouchScroll = useCallback((event: TouchEvent) => {
    if (stateRef.current?.active) event.preventDefault();
  }, []);

  const beginDrag = useCallback(
    (payload: DragPayload, event: ReactPointerEvent) => {
      if (stateRef.current) return;
      // A drag with nowhere to land is not a drag. On a compact viewport the location tree lives
      // in a drawer (issue #147), so while that drawer is closed no row is registered and there
      // is no drop this gesture could ever resolve to. Arming it anyway would be actively worse
      // than doing nothing: a 250ms long press would take over the touch, stop the item list
      // scrolling under the finger (see `suppressTouchScroll`), drag a preview chip around, and
      // then silently discard the whole thing. Refuse at source — the keyboard-accessible "Move
      // item" action stays the complete path, exactly as it is for assistive tech.
      if (dropTargets.current.size === 0) return;
      const listeners = new AbortController();
      const { signal } = listeners;
      stateRef.current = {
        payload,
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
        // Bind the (non-passive) scroll-suppressor now, with the touch, so a later
        // `preventDefault()` is actually honoured once the drag arms — see `suppressTouchScroll`.
        window.addEventListener('touchmove', suppressTouchScroll, { passive: false, signal });
        stateRef.current.longPressTimer = window.setTimeout(activateDrag, TOUCH_LONG_PRESS_MS);
      }
    },
    [activateDrag, onPointerCancel, onPointerMove, onPointerUp, suppressTouchScroll],
  );

  const registerDropTarget = useCallback((id: string, target: DropTarget) => {
    dropTargets.current.set(id, target);
  }, []);
  const unregisterDropTarget = useCallback((id: string) => {
    dropTargets.current.delete(id);
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

  // Defensive: if the provider unmounts mid-drag, `endGesture` never runs — don't leave the
  // global drag-cursor classes or the selection lock stuck on <body>.
  useLayoutEffect(
    () => () => {
      document.body.classList.remove(DRAGGING_CLASS, DRAG_INVALID_CLASS);
      document.body.style.userSelect = '';
    },
    [],
  );

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
