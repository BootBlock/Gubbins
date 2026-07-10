/**
 * useBoardPointerDrag — a Pointer Events drag-to-reorder for the customisable dashboard
 * boards ({@link DashboardNav} tiles and the {@link DashboardGrid} widget board).
 *
 * The boards shipped on **native HTML5 drag-and-drop** (`draggable` + `onDragStart`/`onDrop`),
 * which never fires on touchscreens — so a tablet or kiosk user (the app's primary hardware)
 * could not rearrange their dashboard at all (issue #11). This hook replaces that with a single
 * Pointer Events path that behaves identically for mouse, pen and touch, mirroring the
 * inventory workspace's `item-drag.tsx` seam:
 *
 * - **A drag *source*** (a tile) is pressed and dragged; a floating preview follows the pointer
 *   while `document.elementFromPoint` hit-tests the **drop *target*** underneath.
 * - **Touch disambiguates scroll from drag with a long press.** A touch that moves before the
 *   press delay is a scroll and is left alone; once armed, a non-passive `touchmove` handler
 *   suppresses the browser's scroll so the finger drags instead. Mouse/pen arm on the first few
 *   pixels of movement, preserving plain clicks on the tile's controls.
 * - **Drops are keyed strings.** Each drop target declares a `dropProps(key)`; on release over a
 *   target the board's `onDrop(sourceId, key)` runs the (pure) reorder. The board owns what a key
 *   means (a group + index for the nav, a grid cell for the widgets).
 *
 * This is an *additive* pointer affordance: the keyboard path (arrow keys) and the new on-tile
 * move buttons remain the accessible, touch-free ways to reorder.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** Movement (px) after which a mouse/pen press becomes a drag rather than a click. */
const DRAG_ACTIVATE_DISTANCE = 5;
/** How long a touch must stay put before it arms a drag (vs. scrolling the page). */
const TOUCH_LONG_PRESS_MS = 250;
/** Movement (px) during the long-press window that instead resolves the touch as a scroll. */
const TOUCH_CANCEL_DISTANCE = 10;
/** Distance (px) from the viewport edge within which a live drag auto-scrolls the page. */
const AUTOSCROLL_EDGE = 56;
/** Peak auto-scroll speed (px per frame) at the very edge. */
const AUTOSCROLL_MAX_SPEED = 16;
/** Offset (px) of the floating preview from the pointer so it clears the fingertip. */
const PREVIEW_OFFSET = 14;

/**
 * Body class applied while a pointer drag is live — the same global rule `item-drag.tsx` uses,
 * forcing the `grabbing` cursor across every element so it doesn't flicker as the pointer crosses
 * the UI (defined in src/styles/index.css).
 */
const DRAGGING_CLASS = 'gubbins-dragging';

/** Mutable per-gesture state, held in a ref so pointer ticks never re-render. */
interface DragState {
  id: string;
  /** The dragged tile's label, shown in the floating preview. */
  label: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  longPressTimer: number | null;
  raf: number | null;
  /** Removes every window/document listener for this gesture in one `abort()`. */
  listeners: AbortController;
}

/** Props a draggable tile spreads onto its root element to become a pointer-drag source. */
export interface DragSourceProps {
  readonly onPointerDown: (e: ReactPointerEvent) => void;
  readonly onDragStart: (e: ReactDragEvent) => void;
}

/** Props a drop target spreads onto its element to register under a board-scoped key. */
export interface DropTargetProps {
  readonly 'data-board-drop': string;
  readonly 'data-drag-board': string;
}

export interface BoardPointerDrag {
  /** The id of the tile currently being dragged, or null. Drives the source's drag styling. */
  readonly draggingId: string | null;
  /** The drop key currently under the pointer (a live drop target on this board), or null. */
  readonly overKey: string | null;
  /** Props a draggable tile spreads onto its root: begins a drag of `id`, previewing `label`. */
  readonly sourceProps: (id: string, label: string) => DragSourceProps;
  /** Props a drop target spreads onto its element, registering it under `key` for this board. */
  readonly dropProps: (key: string) => DropTargetProps;
  /** The floating drag preview — render it once anywhere in the board's tree (it portals to body). */
  readonly preview: ReactNode;
}

/**
 * True when a press that began on `target` should be left to its own control rather than starting
 * a drag — a tap on the pin/move buttons (or any nested interactive element) must click, not drag.
 * The drag handle glyph is not interactive, so pressing it still drags.
 */
function isControlPress(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a, input, select, textarea, [role="button"]') !== null
  );
}

/**
 * Own a single board's pointer drag. `boardId` scopes hit-testing to this board's own drop
 * targets, so a nav-tile drag can never resolve onto a widget-board cell (or vice-versa) when the
 * two boards sit on the same page. `onDrop` is called with the dragged tile's id and the key of
 * the drop target released over — the board maps that key to a pure reorder op.
 */
export function useBoardPointerDrag(opts: {
  boardId: string;
  enabled: boolean;
  onDrop: (sourceId: string, dropKey: string) => void;
}): BoardPointerDrag {
  const { boardId, enabled, onDrop } = opts;
  const stateRef = useRef<DragState | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);

  // Keep the latest onDrop reachable from the stable pointer handlers without re-subscribing
  // window listeners every render.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  // The drop key under the point, scoped to this board (a target from the *other* board resolves
  // to null so it never highlights or receives the drop). Guarded for jsdom, where
  // `elementFromPoint` is absent — the pointer path then simply never resolves a target.
  const resolveKey = useCallback(
    (x: number, y: number): string | null => {
      if (typeof document.elementFromPoint !== 'function') return null;
      const el = document.elementFromPoint(x, y);
      const target = el instanceof Element ? el.closest<HTMLElement>('[data-board-drop]') : null;
      if (!target || target.getAttribute('data-drag-board') !== boardId) return null;
      return target.getAttribute('data-board-drop');
    },
    [boardId],
  );

  const positionPreview = useCallback((x: number, y: number) => {
    const el = previewRef.current;
    if (el) el.style.transform = `translate(${x + PREVIEW_OFFSET}px, ${y + PREVIEW_OFFSET}px)`;
  }, []);

  // Auto-scroll the page while a drag hovers near the top/bottom of the viewport, so a tall board
  // stays reachable on touch (where the finger is captured and can't scroll the page itself).
  const autoScrollStep = useCallback(() => {
    const s = stateRef.current;
    if (!s || !s.active) return;
    const vh = window.innerHeight;
    if (s.lastY < AUTOSCROLL_EDGE) window.scrollBy(0, -edgeSpeed(AUTOSCROLL_EDGE - s.lastY));
    else if (s.lastY > vh - AUTOSCROLL_EDGE) window.scrollBy(0, edgeSpeed(AUTOSCROLL_EDGE - (vh - s.lastY)));
    s.raf = requestAnimationFrame(autoScrollStep);
  }, []);

  const endGesture = useCallback(() => {
    const s = stateRef.current;
    if (!s) return;
    if (s.longPressTimer != null) clearTimeout(s.longPressTimer);
    if (s.raf != null) cancelAnimationFrame(s.raf);
    s.listeners.abort();
    if (s.active) {
      document.body.style.userSelect = '';
      document.body.classList.remove(DRAGGING_CLASS);
      // A drag that ends over a button (pin / move) would otherwise fire a click and toggle it.
      // Swallow the one click the release generates (capture phase); clean up shortly after in
      // case no click follows.
      const swallow = (event: Event) => event.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 350);
    }
    stateRef.current = null;
    setDraggingId(null);
    setOverKey(null);
    setPreviewLabel(null);
  }, []);

  // Promote an armed press to a live drag: mount the preview, suppress scroll/selection, and start
  // hit-testing + auto-scroll.
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
    if (s.pointerType === 'touch') {
      window.addEventListener('touchmove', (e) => e.preventDefault(), {
        passive: false,
        signal: s.listeners.signal,
      });
    }
    setDraggingId(s.id);
    setPreviewLabel(s.label);
    positionPreview(s.lastX, s.lastY);
    setOverKey(resolveKey(s.lastX, s.lastY));
    if (typeof requestAnimationFrame === 'function') s.raf = requestAnimationFrame(autoScrollStep);
  }, [autoScrollStep, positionPreview, resolveKey]);

  const beginDrag = useCallback(
    (id: string, label: string, event: ReactPointerEvent) => {
      if (!enabled || stateRef.current) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (isControlPress(event.target)) return;

      const listeners = new AbortController();
      const { signal } = listeners;
      const state: DragState = {
        id,
        label,
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
      stateRef.current = state;

      const onMove = (e: PointerEvent) => {
        const st = stateRef.current;
        if (!st || e.pointerId !== st.pointerId) return;
        st.lastX = e.clientX;
        st.lastY = e.clientY;
        if (!st.active) {
          const distance = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
          if (st.pointerType === 'touch') {
            if (distance > TOUCH_CANCEL_DISTANCE) endGesture();
          } else if (distance > DRAG_ACTIVATE_DISTANCE) {
            activateDrag();
          }
          return;
        }
        positionPreview(e.clientX, e.clientY);
        const next = resolveKey(e.clientX, e.clientY);
        setOverKey((prev) => (prev === next ? prev : next));
      };
      const onUp = (e: PointerEvent) => {
        const st = stateRef.current;
        if (!st || e.pointerId !== st.pointerId) return;
        const dropKey = st.active ? resolveKey(e.clientX, e.clientY) : null;
        const sourceId = st.id;
        endGesture();
        if (dropKey) onDropRef.current(sourceId, dropKey);
      };
      const onCancel = (e: PointerEvent) => {
        const st = stateRef.current;
        if (!st || e.pointerId !== st.pointerId) return;
        endGesture();
      };

      window.addEventListener('pointermove', onMove, { signal });
      window.addEventListener('pointerup', onUp, { signal });
      window.addEventListener('pointercancel', onCancel, { signal });
      // Touch can't tell drag from scroll up front, so it arms on a stationary long press;
      // mouse/pen arm on the first few pixels of movement (preserving plain clicks).
      if (event.pointerType === 'touch') {
        state.longPressTimer = window.setTimeout(activateDrag, TOUCH_LONG_PRESS_MS);
      }
    },
    [activateDrag, enabled, endGesture, positionPreview, resolveKey],
  );

  const sourceProps = useCallback(
    (id: string, label: string) => ({
      onPointerDown: (e: ReactPointerEvent) => beginDrag(id, label, e),
      // Cancel any native HTML drag a descendant (an icon, selected text) would otherwise start —
      // the pointer path is the only drag system.
      onDragStart: (e: ReactDragEvent) => e.preventDefault(),
    }),
    [beginDrag],
  );

  const dropProps = useCallback(
    (key: string) => ({ 'data-board-drop': key, 'data-drag-board': boardId }),
    [boardId],
  );

  // Position the freshly-mounted preview at the current pointer before the browser paints, so a
  // touch long-press — which mounts it without an immediate pointermove — never flashes it at the
  // viewport origin.
  useLayoutEffect(() => {
    const s = stateRef.current;
    if (previewLabel !== null && s) positionPreview(s.lastX, s.lastY);
  }, [previewLabel, positionPreview]);

  // Defensive: if the board unmounts mid-drag, endGesture never runs — abort the in-flight gesture
  // so its window listeners don't leak and <body> isn't left locked in the drag cursor / no-select.
  useLayoutEffect(
    () => () => {
      stateRef.current?.listeners.abort();
      document.body.classList.remove(DRAGGING_CLASS);
      document.body.style.userSelect = '';
    },
    [],
  );

  const preview = useMemo<ReactNode>(
    () =>
      previewLabel !== null
        ? createPortal(
            <div
              ref={previewRef}
              aria-hidden="true"
              data-testid="board-drag-preview"
              className="pointer-events-none fixed left-0 top-0 z-[80] max-w-[16rem] truncate rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-lg"
            >
              {previewLabel}
            </div>,
            document.body,
          )
        : null,
    [previewLabel],
  );

  return { draggingId, overKey, sourceProps, dropProps, preview };
}

/** Auto-scroll speed ramping from 0 at the edge threshold to the peak at the very edge. */
function edgeSpeed(depth: number): number {
  return Math.ceil((Math.min(Math.max(depth, 0), AUTOSCROLL_EDGE) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX_SPEED);
}
