/**
 * `RegionCanvas` — a photo with a shape overlay drawn on it (issue #81).
 *
 * Nothing else in the app draws shapes over an image, so this is a genuinely new Foundry
 * primitive rather than one-off styling at a call site. It serves two call sites from one
 * component: the **read-only viewer** (the item side, "here is where this lives") and the
 * **region editor** (the location side, where regions are drawn, moved and resized). Read-only is
 * therefore the *default* — a caller must opt in to editing, so a viewer can never accidentally
 * ship a drawing surface.
 *
 * ## Where the maths lives
 *
 * None of it is here. The coordinate space, the letterbox transform, the circle aspect correction
 * and the clamping are `features/inventory/regions/geometry`; "which shape did I click?" is
 * `hit-test`; the press/drag/release gesture is the pure reducer in `draw-machine`; and the
 * arrow-key nudge/resize is `region-keyboard`. All four are DOM-free and unit-tested directly,
 * because **jsdom lays nothing out** — `getBoundingClientRect` returns zeros and there is no
 * `elementFromPoint` — so logic left in the component would be logic that could not be tested.
 * What remains here is glue: measuring, translating pointer events into machine events, and
 * painting.
 *
 * ## Layout — `object-contain`, never `object-cover`
 *
 * A photo being *drawn on* must be shown whole, so it is contained (letterboxed) rather than
 * cropped to fill. The overlay is positioned by CSS — an absolutely-centred box carrying the
 * image's own `aspect-ratio`, capped at the container — which is the same rule
 * {@link containBox} implements, so the two agree by construction and the overlay needs no
 * measurement to be correctly placed on first paint. `containBox` is still what turns a *pointer*
 * position into image space, which does need the measured container.
 *
 * The SVG's `viewBox` is the image's own intrinsic size, so shape coordinates are simply
 * normalised × natural. That is also a quiet proof of the aspect correction: a circle's `rx` and
 * `ry` come out **equal** in this space, which is exactly what "renders as a circle, not an
 * ellipse" means.
 *
 * ## Pointer discipline
 *
 * Modelled on `features/inventory/item-drag`:
 *
 * - **Touch arms on a long press**, so a tap still selects and a swipe still scrolls the page.
 *   **Mouse and pen arm on a few pixels of movement**, so a plain click stays a click.
 * - **Every listener is torn down by a single `AbortController.abort()`** — there is no
 *   `removeEventListener` bookkeeping to get wrong, and an unmount mid-gesture cannot leak.
 * - **The non-passive `touchmove` suppressor is bound at `pointerdown`, not when the gesture
 *   arms.** This is the subtle one: a touch engine fixes a gesture's cancelability at its *start*,
 *   so a `preventDefault()` from a listener added later is silently ignored and the finger scrolls
 *   the page instead of drawing. It is bound up front and does nothing until the gesture arms.
 * - The surface sets `touch-action: none` while editing, so the browser hands the whole gesture
 *   over rather than claiming it for panning. (Read-only keeps the default: a viewer embedded in a
 *   scrolling dialog must still be scrollable past.)
 *
 * ## Accessibility
 *
 * A pointer-drawn overlay is an *additive* affordance and can never be the only path:
 *
 * - Each region is a `role="button"` with an accessible name, in the tab order, activated by
 *   Enter/Space.
 * - Arrow keys nudge the selected region and `Shift`+arrows resize it, resolved by the pure
 *   `resolveRegionKey`. Keys the canvas does not own fall through untouched, so Tab always leaves.
 * - Every user-facing string arrives as a **prop with an English default** rather than being
 *   hard-coded here, so the call site supplies translated copy through `t()`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@/lib/utils';
import { locationColorStrokeClass } from '@/features/inventory/location-color';
import type { RegionShape } from '@/db/repositories/constants';
import {
  containBox,
  displayToNormalised,
  parseGeometry,
  circleRadii,
  boundsOf,
  type NormalisedPoint,
  type RegionGeometry,
} from '@/features/inventory/regions/geometry';
import { hitTest, geometryContains } from '@/features/inventory/regions/hit-test';
import {
  drawReducer,
  initialDrawState,
  type DrawState,
  type DrawTool,
  type ResizeHandle,
} from '@/features/inventory/regions/draw-machine';
import { applyRegionKey, resolveRegionKey } from '@/features/inventory/regions/region-keyboard';

/** Pointer travel, in CSS pixels, before a mouse/pen press becomes a drag rather than a click. */
const DRAG_ACTIVATE_DISTANCE = 5;
/** How long a finger must rest before a touch press becomes a drag rather than a tap. */
const TOUCH_LONG_PRESS_MS = 250;
/** Touch travel, in CSS pixels, before the long press is abandoned as a scroll. */
const TOUCH_CANCEL_DISTANCE = 10;

/** Outline weights in CSS pixels — kept constant at any zoom by `vector-effect`. */
const STROKE_WIDTH = 2;
const SELECTED_STROKE_WIDTH = 3.5;
/** The near-black halo under every outline is drawn this much wider, leaving ~1.5px each side. */
const CASING_EXTRA = 3;

/** Region body fill opacity — low enough that the photo still reads through a tinted region. */
const FILL_OPACITY = 0.16;

/**
 * Grab-handle radius, as a fraction of the photo's **shorter** side. Sized against the photo
 * rather than the viewport because the whole overlay scales with the photo; a handle fixed in CSS
 * pixels would need the rendered size measured, which is the measurement this component
 * deliberately does not need in order to paint.
 */
const HANDLE_RADIUS_FRACTION = 0.012;

/** The eight compass handles of a rectangle, as unit offsets within its own box. */
const RECT_HANDLES: readonly (readonly [ResizeHandle, number, number])[] = [
  ['nw', 0, 0],
  ['n', 0.5, 0],
  ['ne', 1, 0],
  ['e', 1, 0.5],
  ['se', 1, 1],
  ['s', 0.5, 1],
  ['sw', 0, 1],
  ['w', 0, 0.5],
];

/** A region row as this component needs it — the persisted shape, not a repository type. */
export interface RegionCanvasRegion {
  readonly id: string;
  readonly name: string;
  readonly shape: RegionShape;
  /** The `geometry` column: JSON in normalised image space. Unparseable rows simply do not draw. */
  readonly geometry: string;
  /** A `--loc-*` swatch key, or `null` for the untinted `--shape-*` overlay colours. */
  readonly color: string | null;
  /** Stacking order — higher sits on top, and wins an overlapping click. */
  readonly position: number;
}

export interface RegionCanvasProps {
  /** Object URL or data URL for the photo. */
  src: string;
  /** Alternative text for the photo. Required — this is a content image, not decoration. */
  alt: string;
  /** The photo's intrinsic size, stored alongside it so the overlay is correct before it loads. */
  naturalWidth: number;
  naturalHeight: number;
  regions: readonly RegionCanvasRegion[];
  selectedId?: string | null;
  /** `null` (the default) selects and edits existing shapes; a tool draws new ones. */
  tool?: DrawTool | null;
  /** **Defaults to `true`.** Read-only renders and selects, but never draws, moves or resizes. */
  readOnly?: boolean;
  onSelect?: (id: string | null) => void;
  /** A gesture or key press produced new geometry for the selected region — persist it. */
  onCommit?: (geometry: RegionGeometry) => void;
  className?: string;
  /**
   * Accessible name for a region shape. Defaults to the region's own name; a call site should
   * pass a translated, count-bearing name ("Top shelf, 3 items").
   */
  regionLabel?: (region: RegionCanvasRegion) => string;
  /** Accessible name for the overlay as a whole. */
  overlayLabel?: string;
  /** Accessible name for a resize handle, given its compass/vertex identity. */
  handleLabel?: (handle: ResizeHandle) => string;
}

/** Squared distance between two normalised points (no square root needed to compare). */
function distanceSquared(a: NormalisedPoint, b: NormalisedPoint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** Every handle the selected shape offers, as normalised anchor points. */
function handlesFor(
  geometry: RegionGeometry,
  naturalWidth: number,
  naturalHeight: number,
): readonly { readonly handle: ResizeHandle; readonly at: NormalisedPoint }[] {
  switch (geometry.shape) {
    case 'rect':
      return RECT_HANDLES.map(([handle, fx, fy]) => ({
        handle,
        at: { x: geometry.x + geometry.w * fx, y: geometry.y + geometry.h * fy },
      }));

    case 'circle': {
      // One handle, on the right of the circle — the single degree of freedom it has.
      const { rx } = circleRadii(geometry.r, naturalWidth, naturalHeight);
      return [{ handle: 'radius', at: { x: geometry.cx + rx, y: geometry.cy } }];
    }

    case 'polygon':
      return geometry.points.map((point, index) => ({
        handle: `vertex:${index}` as ResizeHandle,
        at: point,
      }));
  }
}

export function RegionCanvas({
  src,
  alt,
  naturalWidth,
  naturalHeight,
  regions,
  selectedId = null,
  tool = null,
  readOnly = true,
  onSelect,
  onCommit,
  className,
  regionLabel = (region) => region.name,
  overlayLabel = 'Photo regions',
  handleLabel = (handle) => `Resize region (${handle})`,
}: RegionCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const image = useMemo(() => ({ naturalWidth, naturalHeight }), [naturalWidth, naturalHeight]);
  const activeTool: DrawTool = readOnly ? 'select' : (tool ?? 'select');

  // The draw machine is held in a ref *and* mirrored into state: the pointer handlers need the
  // latest state synchronously (they run outside React's event system, off window listeners),
  // while the render needs it as state. One reducer, two readers.
  const machineRef = useRef<DrawState>(initialDrawState(activeTool, image));
  const [draw, setDraw] = useState<DrawState>(machineRef.current);

  /** Parsed, drawable regions. An unparseable row is dropped rather than taking the screen down. */
  const parsed = useMemo(
    () =>
      regions.flatMap((region) => {
        const geometry = parseGeometry(region.geometry, region.shape);
        return geometry ? [{ region, geometry, position: region.position }] : [];
      }),
    [regions],
  );

  const selected = useMemo(
    () => parsed.find((entry) => entry.region.id === selectedId) ?? null,
    [parsed, selectedId],
  );

  /** Push an event through the pure reducer, mirror the result, and report any commit once. */
  const dispatch = useCallback(
    (event: Parameters<typeof drawReducer>[1]) => {
      const next = drawReducer(machineRef.current, event);
      machineRef.current = next;
      setDraw(next);
      if (next.committed) onCommit?.(next.committed);
    },
    [onCommit],
  );

  // Keep the machine's tool and its notion of the selected geometry in step with the props that
  // own them. The machine is the source of truth *during* a gesture only.
  useEffect(() => {
    if (machineRef.current.tool !== activeTool) dispatch({ type: 'tool', tool: activeTool });
  }, [activeTool, dispatch]);

  useEffect(() => {
    dispatch({ type: 'select', geometry: selected?.geometry ?? null });
    // Only when the *identity* of the selection changes: re-dispatching on every geometry object
    // would abort a gesture in flight the moment its own commit re-rendered the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /**
   * Translate a client-space pointer position into normalised image space, or `null` when the
   * element has not been laid out. Under **jsdom** `getBoundingClientRect` returns zeros, which
   * `containBox` reports as `null` — the guard that keeps a test from dividing by zero.
   */
  const toNormalised = useCallback(
    (clientX: number, clientY: number): NormalisedPoint | null => {
      const element = containerRef.current;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const content = containBox(naturalWidth, naturalHeight, rect.width, rect.height);
      if (!content) return null;
      return displayToNormalised({ x: clientX - rect.left, y: clientY - rect.top }, content);
    },
    [naturalWidth, naturalHeight],
  );

  /** Live gesture bookkeeping. Held in a ref so the window listeners see it without re-binding. */
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    armed: boolean;
    longPressTimer: number | null;
    listeners: AbortController;
  } | null>(null);

  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.longPressTimer != null) clearTimeout(gesture.longPressTimer);
    gesture.listeners.abort(); // removes pointermove/up/cancel *and* touchmove in one shot
    gestureRef.current = null;
  }, []);

  // Defensive: an unmount mid-gesture would otherwise leave window listeners bound to a dead tree.
  useEffect(() => endGesture, [endGesture]);

  const beginGesture = useCallback(
    (event: ReactPointerEvent, target: 'canvas' | 'shape' | 'handle', handle?: ResizeHandle) => {
      if (readOnly || gestureRef.current) return;
      const point = toNormalised(event.clientX, event.clientY);
      if (!point) return; // not laid out — nothing sensible to draw against

      dispatch({ type: 'pointerdown', point, target, handle });

      const listeners = new AbortController();
      const { signal } = listeners;
      const state = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        armed: false,
        longPressTimer: null as number | null,
        listeners,
      };
      gestureRef.current = state;

      const onMove = (moveEvent: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || moveEvent.pointerId !== gesture.pointerId) return;
        if (!gesture.armed) {
          const distance = Math.hypot(moveEvent.clientX - gesture.startX, moveEvent.clientY - gesture.startY);
          if (moveEvent.pointerType === 'touch') {
            // Moving before the long press means the user meant to scroll — let the gesture go.
            if (distance > TOUCH_CANCEL_DISTANCE) {
              dispatch({ type: 'cancel' });
              endGesture();
            }
          } else if (distance > DRAG_ACTIVATE_DISTANCE) {
            gesture.armed = true;
          }
          if (!gesture.armed) return;
        }
        const movePoint = toNormalised(moveEvent.clientX, moveEvent.clientY);
        if (movePoint) dispatch({ type: 'pointermove', point: movePoint });
      };

      const onUp = (upEvent: PointerEvent) => {
        const gesture = gestureRef.current;
        if (!gesture || upEvent.pointerId !== gesture.pointerId) return;
        endGesture();
        const upPoint = toNormalised(upEvent.clientX, upEvent.clientY);
        // Dispatched whether or not the gesture armed: a *click* is how a polygon places its
        // vertices, and an unarmed rect/circle is a stray tap the machine discards on size.
        if (upPoint) dispatch({ type: 'pointerup', point: upPoint });
      };

      const onCancel = (cancelEvent: PointerEvent) => {
        if (gestureRef.current?.pointerId !== cancelEvent.pointerId) return;
        endGesture();
        dispatch({ type: 'cancel' });
      };

      window.addEventListener('pointermove', onMove, { signal });
      window.addEventListener('pointerup', onUp, { signal });
      window.addEventListener('pointercancel', onCancel, { signal });

      if (event.pointerType === 'touch') {
        // Bound NOW, with the touch, so the `preventDefault()` below is actually honoured once the
        // gesture arms: a touch engine fixes cancelability at gesture start, and a non-passive
        // listener added when the long press fires is already too late (see the module header).
        window.addEventListener(
          'touchmove',
          (touchEvent: TouchEvent) => {
            if (gestureRef.current?.armed) touchEvent.preventDefault();
          },
          { passive: false, signal },
        );
        state.longPressTimer = window.setTimeout(() => {
          if (gestureRef.current) gestureRef.current.armed = true;
        }, TOUCH_LONG_PRESS_MS);
      }
    },
    [readOnly, toNormalised, dispatch, endGesture],
  );

  /**
   * What a press at this point has hold of. Resolved by the pure {@link hitTest} rather than by
   * `elementFromPoint`, so the same answer is reachable from a unit test and from the keyboard —
   * and so an SVG stroke's exact pixel coverage never decides which region was clicked.
   */
  const onSurfacePointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const point = toNormalised(event.clientX, event.clientY);
      if (!point) return;

      // A grabbed handle takes precedence, then the selected shape's own body.
      if (!readOnly && selected) {
        const radius = HANDLE_RADIUS_FRACTION * 2; // a forgiving grab radius, ~2 handle widths
        for (const { handle, at } of handlesFor(selected.geometry, naturalWidth, naturalHeight)) {
          if (distanceSquared(point, at) <= radius * radius) {
            beginGesture(event, 'handle', handle);
            return;
          }
        }
        if (geometryContains(selected.geometry, point, naturalWidth, naturalHeight)) {
          beginGesture(event, 'shape');
          return;
        }
      }

      // Otherwise this is a selection press (or the start of a new shape).
      if (activeTool === 'select') {
        const hit = hitTest(parsed, point, naturalWidth, naturalHeight);
        onSelect?.(hit ? hit.region.id : null);
      }
      if (!readOnly) beginGesture(event, 'canvas');
    },
    [
      toNormalised,
      readOnly,
      selected,
      naturalWidth,
      naturalHeight,
      beginGesture,
      activeTool,
      parsed,
      onSelect,
    ],
  );

  const onRegionKeyDown = useCallback(
    (event: React.KeyboardEvent, entry: { region: RegionCanvasRegion; geometry: RegionGeometry }) => {
      const action = resolveRegionKey(event.key, {
        shift: event.shiftKey,
        coarse: event.ctrlKey || event.metaKey,
      });
      if (!action) return; // not ours — Tab and everything else keep their meaning
      event.preventDefault();

      switch (action.kind) {
        case 'activate':
          onSelect?.(entry.region.id);
          return;
        case 'cancel':
          onSelect?.(null);
          return;
        case 'nudge':
        case 'resize': {
          // Only the selected region moves, and only when editing.
          if (readOnly || entry.region.id !== selectedId) return;
          onCommit?.(applyRegionKey(entry.geometry, action, naturalWidth, naturalHeight));
        }
      }
    },
    [onSelect, onCommit, readOnly, selectedId, naturalWidth, naturalHeight],
  );

  const handleRadius = Math.min(naturalWidth, naturalHeight) * HANDLE_RADIUS_FRACTION;

  return (
    <div
      ref={containerRef}
      className={cn('relative flex items-center justify-center overflow-hidden', className)}
    >
      <img
        src={src}
        alt={alt}
        // `object-contain`, never `object-cover`: the whole photo must be visible to draw on.
        className="absolute inset-0 size-full object-contain"
        draggable={false}
      />
      {/*
       * The overlay is placed by CSS at exactly the letterboxed content box — absolutely centred,
       * carrying the photo's own aspect ratio and capped at the container. That is the same rule
       * `containBox` computes, so the painted overlay and the pointer maths agree by construction
       * and neither waits on a measurement. The ratio is data-derived, so it is an inline style
       * rather than a Tailwind class (a computed `aspect-[…]` would not be scanned).
       */}
      <svg
        role="group"
        aria-label={overlayLabel}
        viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          aspectRatio: `${naturalWidth} / ${naturalHeight}`,
          // Handed the whole gesture while editing; a read-only viewer stays scrollable.
          touchAction: readOnly ? undefined : 'none',
        }}
        className={cn(
          'relative max-h-full max-w-full',
          readOnly ? 'cursor-default' : activeTool === 'select' ? 'cursor-pointer' : 'cursor-crosshair',
        )}
        data-testid="region-canvas-surface"
        onPointerDown={onSurfacePointerDown}
      >
        {parsed.map((entry) => {
          const isSelected = entry.region.id === selectedId;
          const tint = locationColorStrokeClass(entry.region.color);
          return (
            <g
              key={entry.region.id}
              role="button"
              tabIndex={0}
              aria-label={regionLabel(entry.region)}
              aria-pressed={isSelected}
              data-region-id={entry.region.id}
              className="outline-none focus-visible:[&>*]:opacity-100"
              onClick={() => onSelect?.(entry.region.id)}
              onKeyDown={(event) => onRegionKeyDown(event, entry)}
            >
              {/* The near-black casing under the outline — what keeps a bright stroke legible on a
                  bright photo, and a region visible on any image at all. */}
              <ShapePath
                geometry={entry.geometry}
                naturalWidth={naturalWidth}
                naturalHeight={naturalHeight}
                className="fill-none stroke-shape-casing"
                strokeWidth={(isSelected ? SELECTED_STROKE_WIDTH : STROKE_WIDTH) + CASING_EXTRA}
              />
              <ShapePath
                geometry={entry.geometry}
                naturalWidth={naturalWidth}
                naturalHeight={naturalHeight}
                className={cn(
                  isSelected ? 'stroke-shape-stroke-selected' : (tint ?? 'stroke-shape-stroke'),
                  tint ?? 'fill-shape-fill',
                )}
                fillOpacity={tint ? FILL_OPACITY : undefined}
                strokeWidth={isSelected ? SELECTED_STROKE_WIDTH : STROKE_WIDTH}
              />
            </g>
          );
        })}

        {/* The live preview of whatever is being drawn, moved or resized. Dashed and unfocusable —
            it is feedback, not yet a region, so it is hidden from assistive technology. */}
        {draw.draft ? (
          <g aria-hidden="true" data-testid="region-canvas-draft">
            <ShapePath
              geometry={draw.draft}
              naturalWidth={naturalWidth}
              naturalHeight={naturalHeight}
              className="fill-none stroke-shape-casing"
              strokeWidth={SELECTED_STROKE_WIDTH + CASING_EXTRA}
            />
            <ShapePath
              geometry={draw.draft}
              naturalWidth={naturalWidth}
              naturalHeight={naturalHeight}
              className="fill-shape-fill stroke-shape-stroke-selected"
              strokeWidth={SELECTED_STROKE_WIDTH}
              strokeDasharray="6 4"
            />
          </g>
        ) : null}

        {/* Grab handles for the selected shape, editing only. Each is a button in its own right so
            a pointer user can grab it; the keyboard equivalent is Shift+arrows on the region. */}
        {!readOnly && selected
          ? handlesFor(selected.geometry, naturalWidth, naturalHeight).map(({ handle, at }) => (
              <circle
                key={handle}
                role="button"
                tabIndex={-1}
                aria-label={handleLabel(handle)}
                data-handle={handle}
                cx={at.x * naturalWidth}
                cy={at.y * naturalHeight}
                r={handleRadius}
                className="fill-shape-handle stroke-shape-casing"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginGesture(event, 'handle', handle);
                }}
              />
            ))
          : null}
      </svg>
    </div>
  );
}

/**
 * One shape, painted in the SVG's image-space `viewBox`.
 *
 * A circle becomes an `<ellipse>` whose two radii are the aspect correction multiplied back out —
 * and in *this* space they come out equal, which is the visible proof that a stored width-relative
 * radius renders as a circle on a non-square photo.
 *
 * `vector-effect="non-scaling-stroke"` keeps the outline a constant number of CSS pixels however
 * large the photo is displayed, so a region on a 6000px photo is not hairline-thin.
 */
function ShapePath({
  geometry,
  naturalWidth,
  naturalHeight,
  className,
  strokeWidth,
  strokeDasharray,
  fillOpacity,
}: {
  geometry: RegionGeometry;
  naturalWidth: number;
  naturalHeight: number;
  className: string;
  strokeWidth: number;
  strokeDasharray?: string;
  fillOpacity?: number;
}) {
  const shared = {
    className,
    strokeWidth,
    strokeDasharray,
    fillOpacity,
    vectorEffect: 'non-scaling-stroke' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (geometry.shape) {
    case 'rect': {
      const bounds = boundsOf(geometry);
      return (
        <rect
          {...shared}
          x={bounds.x * naturalWidth}
          y={bounds.y * naturalHeight}
          width={bounds.w * naturalWidth}
          height={bounds.h * naturalHeight}
        />
      );
    }

    case 'circle': {
      const { rx, ry } = circleRadii(geometry.r, naturalWidth, naturalHeight);
      return (
        <ellipse
          {...shared}
          cx={geometry.cx * naturalWidth}
          cy={geometry.cy * naturalHeight}
          rx={rx * naturalWidth}
          ry={ry * naturalHeight}
        />
      );
    }

    case 'polygon':
      return (
        <polygon
          {...shared}
          points={geometry.points.map((p) => `${p.x * naturalWidth},${p.y * naturalHeight}`).join(' ')}
        />
      );
  }
}
