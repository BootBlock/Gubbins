/**
 * The pure reducer behind drawing, moving and resizing location-photo regions (issue #81).
 *
 * Drawing is a gesture — press, drag, release, with an escape hatch — and gestures are exactly the
 * logic that is hardest to test through a component: **jsdom lays nothing out**, so a test driving
 * the real canvas would be dragging across a zero-sized box reading zeroed rectangles. Modelling
 * the gesture as `(state, event) => state` over already-normalised points moves every rule worth
 * testing — what commits, what aborts, what a stray tap does — into a function with no layout
 * engine behind it. The component's only job is to translate pointer events into these events via
 * `displayToNormalised`, and to render {@link DrawState.draft} as a live preview.
 *
 * @see geometry.ts for the coordinate space and the circle aspect correction.
 */

import {
  clampGeometry,
  boundsOf,
  type NormalisedPoint,
  type RegionGeometry,
  MIN_POLYGON_POINTS,
} from './geometry';

/**
 * The smallest bounding-box extent, per axis in normalised units, a committed region may have —
 * 2% of the image. Below this a shape is almost certainly an accidental tap or a click that
 * drifted a pixel, not an intentional region: it would be nearly impossible to see, select or
 * grab a resize handle on. A gesture that ends smaller than this is **discarded, not clamped up**,
 * because silently creating a region the user did not mean to draw is worse than creating none.
 */
export const MIN_REGION_SIZE = 0.02;

/**
 * How near the first vertex a click must land, in normalised units, to **close** a polygon rather
 * than add another vertex. Comfortably larger than a rendered vertex handle so the gesture is
 * forgiving on a touch screen, and well below {@link MIN_REGION_SIZE}-scale shapes so it cannot
 * swallow a deliberate nearby vertex.
 */
export const POLYGON_CLOSE_DISTANCE = 0.02;

/** The active drawing tool. `select` edits existing shapes; the rest create new ones. */
export type DrawTool = 'select' | 'rect' | 'circle' | 'polygon';

/**
 * A grab handle on the selected shape: a rectangle's eight corner/edge handles, a circle's single
 * radius handle, or a polygon's per-vertex handle addressed by index.
 */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'radius' | `vertex:${number}`;

/** The image's intrinsic size — needed for the circle aspect correction. */
export interface ImageAspect {
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** The gesture currently in flight, if any. */
export type DrawGesture =
  | { readonly kind: 'idle' }
  /** Dragging out a new rectangle (from its first corner) or circle (from its centre). */
  | { readonly kind: 'create'; readonly tool: 'rect' | 'circle'; readonly origin: NormalisedPoint }
  /** Placing polygon vertices, one click at a time. */
  | { readonly kind: 'polygon'; readonly points: readonly NormalisedPoint[] }
  /** Dragging the selected shape bodily. */
  | { readonly kind: 'move'; readonly origin: NormalisedPoint; readonly base: RegionGeometry }
  /** Dragging one of the selected shape's handles. */
  | {
      readonly kind: 'resize';
      readonly handle: ResizeHandle;
      readonly origin: NormalisedPoint;
      readonly base: RegionGeometry;
    };

export interface DrawState {
  readonly tool: DrawTool;
  readonly image: ImageAspect;
  readonly gesture: DrawGesture;
  /**
   * The in-progress shape, for live preview. Non-null only while a gesture is producing something
   * renderable; it is **not** a commitment — an aborted or too-small gesture throws it away.
   */
  readonly draft: RegionGeometry | null;
  /** The geometry of the shape being edited, as it stands between gestures. */
  readonly selected: RegionGeometry | null;
  /**
   * A **one-shot output**: the geometry the caller should persist. It is non-null *only* on the
   * state returned by the event that committed, and cleared by the next event — so a caller can
   * write `if (next.committed) save(next.committed)` in an effect without needing to diff states
   * or risking a double save.
   */
  readonly committed: RegionGeometry | null;
}

/** Everything that can happen to the machine. Points are already in normalised image space. */
export type DrawEvent =
  /** Switch tool — abandons any gesture in flight (an unfinished polygon does not survive). */
  | { readonly type: 'tool'; readonly tool: DrawTool }
  /** Select an existing shape to edit, or clear the selection with `null`. */
  | { readonly type: 'select'; readonly geometry: RegionGeometry | null }
  /**
   * Pointer pressed. `target` says what was under it — bare photo, the selected shape's body, or
   * one of its handles — which the component knows from its own event target and the machine
   * cannot infer from a coordinate alone.
   */
  | {
      readonly type: 'pointerdown';
      readonly point: NormalisedPoint;
      readonly target?: 'canvas' | 'shape' | 'handle';
      readonly handle?: ResizeHandle;
    }
  | { readonly type: 'pointermove'; readonly point: NormalisedPoint }
  | { readonly type: 'pointerup'; readonly point: NormalisedPoint }
  /** Explicitly finish a polygon (a "Finish" button, Enter, or a double-click). */
  | { readonly type: 'finish' }
  /** Abort: Escape, a cancelled pointer, or a pointer leaving the window mid-drag. */
  | { readonly type: 'cancel' };

/** The machine's resting state for `tool`, with nothing selected and nothing in flight. */
export function initialDrawState(tool: DrawTool, image: ImageAspect): DrawState {
  return {
    tool,
    image,
    gesture: { kind: 'idle' },
    draft: null,
    selected: null,
    committed: null,
  };
}

/** The rectangle spanned by two corners, in either drag direction. */
function rectBetween(a: NormalisedPoint, b: NormalisedPoint): RegionGeometry {
  return {
    shape: 'rect',
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/**
 * The circle centred on `centre` whose edge passes through `edge`.
 *
 * The radius is measured in **width-normalised** units, matching how it is stored: the vertical
 * offset is converted through the aspect ratio first, so dragging the same physical distance up or
 * sideways grows the circle equally. Measuring `hypot(dx, dy)` on raw normalised offsets would
 * make a circle grow faster vertically on a wide photo.
 */
function circleBetween(centre: NormalisedPoint, edge: NormalisedPoint, image: ImageAspect): RegionGeometry {
  const { naturalWidth, naturalHeight } = image;
  const aspect =
    Number.isFinite(naturalWidth) && Number.isFinite(naturalHeight) && naturalWidth > 0 && naturalHeight > 0
      ? naturalHeight / naturalWidth
      : 1;
  const dx = edge.x - centre.x;
  const dy = (edge.y - centre.y) * aspect;
  return { shape: 'circle', cx: centre.x, cy: centre.y, r: Math.hypot(dx, dy) };
}

/** Translate any shape by a normalised delta. */
function translate(geometry: RegionGeometry, dx: number, dy: number): RegionGeometry {
  switch (geometry.shape) {
    case 'rect':
      return { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
    case 'circle':
      return { ...geometry, cx: geometry.cx + dx, cy: geometry.cy + dy };
    case 'polygon':
      return { shape: 'polygon', points: geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

/**
 * The eight rectangle handles, named so a compass letter maps to the edge it moves. Matched as a
 * whole name rather than by substring — `'radius'` happens to contain an `'s'`, and a substring
 * test would let a circle's handle drag a rectangle's bottom edge.
 */
const COMPASS_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

/** Apply a handle drag to the shape it belongs to; an inapplicable handle leaves it unchanged. */
function resize(
  base: RegionGeometry,
  handle: ResizeHandle,
  point: NormalisedPoint,
  image: ImageAspect,
): RegionGeometry {
  if (base.shape === 'rect' && (COMPASS_HANDLES as readonly string[]).includes(handle)) {
    let { x, y, w, h } = base;
    let left = x;
    let top = y;
    let right = x + w;
    let bottom = y + h;
    if (handle.includes('w')) left = point.x;
    if (handle.includes('e')) right = point.x;
    if (handle.includes('n')) top = point.y;
    if (handle.includes('s')) bottom = point.y;
    // Normalise so dragging a handle past its opposite edge flips the rectangle rather than
    // producing a negative size.
    x = Math.min(left, right);
    y = Math.min(top, bottom);
    w = Math.abs(right - left);
    h = Math.abs(bottom - top);
    return { shape: 'rect', x, y, w, h };
  }

  if (base.shape === 'circle' && handle === 'radius') {
    return circleBetween({ x: base.cx, y: base.cy }, point, image);
  }

  if (base.shape === 'polygon' && handle.startsWith('vertex:')) {
    const index = Number.parseInt(handle.slice('vertex:'.length), 10);
    if (!Number.isInteger(index) || index < 0 || index >= base.points.length) return base;
    return {
      shape: 'polygon',
      points: base.points.map((p, i) => (i === index ? { x: point.x, y: point.y } : p)),
    };
  }

  return base;
}

/**
 * Whether a shape is big enough to keep — its bounding box must reach {@link MIN_REGION_SIZE} on
 * **both** axes. Applied uniformly to all three shapes, so a stray tap cannot produce a
 * zero-area rectangle, a dot of a circle, or a collapsed polygon.
 */
function isLargeEnough(geometry: RegionGeometry, image: ImageAspect): boolean {
  const bounds = boundsOf(geometry, image.naturalWidth, image.naturalHeight);
  return bounds.w >= MIN_REGION_SIZE && bounds.h >= MIN_REGION_SIZE;
}

/** Squared distance between two normalised points (no square root needed to compare). */
function distanceSquared(a: NormalisedPoint, b: NormalisedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Deep-equal enough for geometry — used to tell a real edit from a no-op drag. */
function sameGeometry(a: RegionGeometry, b: RegionGeometry): boolean {
  if (a.shape !== b.shape) return false;
  if (a.shape === 'rect' && b.shape === 'rect') {
    return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }
  if (a.shape === 'circle' && b.shape === 'circle') {
    return a.cx === b.cx && a.cy === b.cy && a.r === b.r;
  }
  if (a.shape === 'polygon' && b.shape === 'polygon') {
    return (
      a.points.length === b.points.length &&
      a.points.every((p, i) => p.x === b.points[i]!.x && p.y === b.points[i]!.y)
    );
  }
  return false;
}

/** Abort whatever is in flight, restoring the pre-gesture geometry. */
function abort(state: DrawState): DrawState {
  const restored =
    state.gesture.kind === 'move' || state.gesture.kind === 'resize' ? state.gesture.base : state.selected;
  return { ...state, gesture: { kind: 'idle' }, draft: null, selected: restored, committed: null };
}

/** Commit `geometry` (clamped into the image), leaving it selected and reported once. */
function commit(state: DrawState, geometry: RegionGeometry): DrawState {
  const clamped = clampGeometry(geometry, state.image.naturalWidth, state.image.naturalHeight);
  return {
    ...state,
    gesture: { kind: 'idle' },
    draft: null,
    selected: clamped,
    committed: clamped,
  };
}

/**
 * Advance the drawing machine.
 *
 * The gestures it models:
 *
 * - **New rectangle** — press at one corner, drag, release at the opposite corner (either
 *   direction).
 * - **New circle** — press at the **centre**, drag outward; the release point sets the radius.
 * - **New polygon** — click to place each vertex; close it by clicking within
 *   {@link POLYGON_CLOSE_DISTANCE} of the first vertex, or with an explicit `finish` event, once
 *   at least {@link MIN_POLYGON_POINTS} vertices exist.
 * - **Move** — with the `select` tool, press on the selected shape's body and drag.
 * - **Resize** — press on one of its handles and drag (corner/edge for a rectangle, the radius
 *   handle for a circle, a vertex handle for a polygon).
 * - **Abort** — `cancel` (Escape, pointer cancel) at any point throws the draft away and restores
 *   the geometry as it stood before the gesture began.
 *
 * A commit happens only when a gesture genuinely produces something: a shape smaller than
 * {@link MIN_REGION_SIZE} is discarded, and a move or resize that ends where it started reports
 * nothing rather than churning an identical row through the database.
 */
export function drawReducer(state: DrawState, event: DrawEvent): DrawState {
  // `committed` is a one-shot: any event at all clears the previous commit.
  const base: DrawState = state.committed === null ? state : { ...state, committed: null };

  switch (event.type) {
    case 'tool':
      // Switching tools abandons anything in flight, including a half-drawn polygon.
      return { ...base, tool: event.tool, gesture: { kind: 'idle' }, draft: null };

    case 'select':
      return { ...base, gesture: { kind: 'idle' }, draft: null, selected: event.geometry };

    case 'pointerdown': {
      const { point } = event;

      // Editing an existing shape takes precedence: the component only reports these targets when
      // something is selected and grabbed.
      if (base.selected && event.target === 'handle' && event.handle) {
        return {
          ...base,
          gesture: { kind: 'resize', handle: event.handle, origin: point, base: base.selected },
          draft: base.selected,
        };
      }
      if (base.selected && event.target === 'shape') {
        return {
          ...base,
          gesture: { kind: 'move', origin: point, base: base.selected },
          draft: base.selected,
        };
      }

      switch (base.tool) {
        case 'rect':
        case 'circle':
          return {
            ...base,
            gesture: { kind: 'create', tool: base.tool, origin: point },
            draft: null, // nothing renderable until the drag has some extent
          };

        case 'polygon': {
          const points =
            base.gesture.kind === 'polygon' ? base.gesture.points : ([] as readonly NormalisedPoint[]);
          const first = points[0];
          // Clicking the first vertex closes the ring, provided it encloses an area.
          if (
            first &&
            points.length >= MIN_POLYGON_POINTS &&
            distanceSquared(point, first) <= POLYGON_CLOSE_DISTANCE * POLYGON_CLOSE_DISTANCE
          ) {
            const polygon: RegionGeometry = { shape: 'polygon', points };
            return isLargeEnough(polygon, base.image)
              ? commit(base, polygon)
              : { ...base, gesture: { kind: 'idle' }, draft: null };
          }
          const next = [...points, point];
          return {
            ...base,
            gesture: { kind: 'polygon', points: next },
            draft: next.length >= MIN_POLYGON_POINTS ? { shape: 'polygon', points: next } : null,
          };
        }

        case 'select':
          // A press on bare photo with nothing grabbed clears the selection.
          return { ...base, gesture: { kind: 'idle' }, draft: null, selected: null };
      }
      return base;
    }

    case 'pointermove': {
      const { point } = event;
      switch (base.gesture.kind) {
        case 'create':
          return {
            ...base,
            draft:
              base.gesture.tool === 'rect'
                ? rectBetween(base.gesture.origin, point)
                : circleBetween(base.gesture.origin, point, base.image),
          };

        case 'move': {
          const moved = translate(
            base.gesture.base,
            point.x - base.gesture.origin.x,
            point.y - base.gesture.origin.y,
          );
          return {
            ...base,
            draft: clampGeometry(moved, base.image.naturalWidth, base.image.naturalHeight),
          };
        }

        case 'resize':
          return {
            ...base,
            draft: resize(base.gesture.base, base.gesture.handle, point, base.image),
          };

        case 'polygon':
          // The rubber-band edge to the cursor is the component's to draw; the placed vertices are
          // already the draft, and a move places nothing.
          return base;

        case 'idle':
          return base;
      }
      return base;
    }

    case 'pointerup': {
      const { point } = event;
      switch (base.gesture.kind) {
        case 'create': {
          const shape =
            base.gesture.tool === 'rect'
              ? rectBetween(base.gesture.origin, point)
              : circleBetween(base.gesture.origin, point, base.image);
          // A stray tap or a one-pixel drag is discarded rather than grown to the minimum.
          return isLargeEnough(shape, base.image)
            ? commit(base, shape)
            : { ...base, gesture: { kind: 'idle' }, draft: null };
        }

        case 'move':
        case 'resize': {
          const gesture = base.gesture;
          const edited =
            gesture.kind === 'move'
              ? translate(gesture.base, point.x - gesture.origin.x, point.y - gesture.origin.y)
              : resize(gesture.base, gesture.handle, point, base.image);
          const clamped = clampGeometry(edited, base.image.naturalWidth, base.image.naturalHeight);
          // A resize can shrink a shape below the threshold; a no-op drag should not write a row.
          if (!isLargeEnough(clamped, base.image) || sameGeometry(clamped, gesture.base)) {
            return { ...base, gesture: { kind: 'idle' }, draft: null, selected: gesture.base };
          }
          return commit(base, clamped);
        }

        case 'polygon':
        case 'idle':
          return base;
      }
      return base;
    }

    case 'finish': {
      if (base.gesture.kind !== 'polygon') return base;
      const points = base.gesture.points;
      if (points.length < MIN_POLYGON_POINTS) {
        return { ...base, gesture: { kind: 'idle' }, draft: null };
      }
      const polygon: RegionGeometry = { shape: 'polygon', points };
      return isLargeEnough(polygon, base.image)
        ? commit(base, polygon)
        : { ...base, gesture: { kind: 'idle' }, draft: null };
    }

    case 'cancel':
      return abort(base);
  }
}
