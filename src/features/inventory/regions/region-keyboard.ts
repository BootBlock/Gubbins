/**
 * Pure keyboard maths for editing a selected location-photo region (issue #81) — the arrow-key
 * nudge and resize that make the drawing surface usable without a pointer.
 *
 * A pointer-drawn overlay is an *additive* affordance and can never be the only path to a region's
 * geometry, so every gesture the mouse offers has a keyboard equivalent. Kept DOM-free and unit
 * tested directly, mirroring `tree-keyboard.ts` (the same "extract the logic out of the glue" seam
 * used by `focus-trap.ts` and `pagination-window.ts`): the DOM glue — focus, roving tabindex,
 * announcing the change through `LiveRegion`, persisting the result — lives in `RegionCanvas`.
 *
 * Resolution is split in two on purpose:
 *
 * - {@link resolveRegionKey} answers *what the key means*, from the key and its modifiers alone. It
 *   knows nothing about geometry, so the "did we handle this key?" decision (and therefore the
 *   `preventDefault()`) is a single, exhaustively-tested lookup.
 * - {@link applyRegionKey} answers *what that does to a shape*, which needs the geometry and the
 *   image's aspect ratio. Keeping it separate means a caller can resolve a key against a read-only
 *   canvas — where nothing should move — without touching shape maths at all.
 *
 * @see geometry.ts for the coordinate space and the circle aspect correction.
 * @see draw-machine.ts for the pointer equivalent of the same two operations.
 */

import { boundsOf, clampGeometry, type NormalisedPoint, type RegionGeometry } from './geometry';
import { MIN_REGION_SIZE } from './draw-machine';

/**
 * How far one arrow press moves or resizes a region, in normalised units — 0.5% of the image.
 * Small enough that a press is a genuine *adjustment* rather than a jump, so a user can land a
 * region exactly where they mean to; the coarse step exists for crossing the photo.
 */
export const NUDGE_STEP = 0.005;

/**
 * The `Ctrl`/`Cmd`-modified step — 5% of the image, ten times the fine step. Crossing a photo at
 * {@link NUDGE_STEP} would take 200 presses, which is not an accessible path to the far corner.
 */
export const COARSE_NUDGE_STEP = 0.05;

/** The instruction a key press resolves to; `null` means "not ours — do not `preventDefault`". */
export type RegionKeyAction =
  /** Move the selected region by a normalised delta. */
  | { readonly kind: 'nudge'; readonly dx: number; readonly dy: number }
  /** Grow or shrink it, anchored at its top-left, by a normalised delta. */
  | { readonly kind: 'resize'; readonly dx: number; readonly dy: number }
  /** Activate the focused region (select it) — the `role="button"` contract. */
  | { readonly kind: 'activate' }
  /** Abandon whatever is in flight, or clear the selection. */
  | { readonly kind: 'cancel' };

/** The modifier state of the key press. Only the modifiers that change meaning are read. */
export interface RegionKeyModifiers {
  /** `Shift` switches the arrows from moving the region to resizing it. */
  readonly shift?: boolean;
  /** `Ctrl` (or `Cmd`) switches from the fine step to {@link COARSE_NUDGE_STEP}. */
  readonly coarse?: boolean;
}

/** The unit vector each arrow key points along, in normalised image space (y grows downward). */
const ARROWS: Readonly<Record<string, NormalisedPoint>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Map a key press on a selected region to the action it should perform.
 *
 * - **Arrow keys** — nudge the region by {@link NUDGE_STEP}.
 * - **Shift + arrows** — resize it by the same step, anchored at its top-left so the shape grows
 *   toward the bottom-right exactly as dragging its `se` handle would. Right/Down grow, Left/Up
 *   shrink, on every shape.
 * - **Ctrl/Cmd + either** — use the coarse {@link COARSE_NUDGE_STEP} instead.
 * - **Enter / Space** — activate, per the `role="button"` the shapes carry.
 * - **Escape** — cancel.
 *
 * Anything else returns `null` so the key keeps its normal meaning — a caller that swallowed
 * unknown keys here would break Tab, and with it every path out of the canvas.
 */
export function resolveRegionKey(key: string, modifiers: RegionKeyModifiers = {}): RegionKeyAction | null {
  const arrow = ARROWS[key];
  if (arrow) {
    const step = modifiers.coarse ? COARSE_NUDGE_STEP : NUDGE_STEP;
    const dx = arrow.x * step;
    const dy = arrow.y * step;
    return modifiers.shift ? { kind: 'resize', dx, dy } : { kind: 'nudge', dx, dy };
  }

  switch (key) {
    case 'Enter':
    case ' ':
      return { kind: 'activate' };
    case 'Escape':
      return { kind: 'cancel' };
    default:
      return null;
  }
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
 * Grow or shrink a shape by a normalised delta, **anchored at the top-left of its bounding box** —
 * the keyboard equivalent of dragging the `se` handle, so the two paths agree about which corner
 * stays put.
 *
 * Each shape reaches that outcome differently, and only the rectangle's is obvious:
 *
 * - A **rectangle** takes the delta straight onto `w`/`h`.
 * - A **circle** has one degree of freedom, so the two axes are summed (only one arrow is ever
 *   non-zero) and applied to `r`. `r` is width-normalised, so the aspect correction is handled by
 *   {@link clampGeometry} and the renderer rather than here. The circle also anchors at its
 *   bounding box's top-left, which means growing it moves the centre — otherwise the top-left
 *   corner would drift and Shift+Right would not agree with the `se` handle.
 * - A **polygon** has no single size, so its bounding box is scaled about that same anchor and the
 *   vertices carried along proportionally, preserving its shape.
 *
 * A shrink is floored at {@link MIN_REGION_SIZE} rather than allowed through: a region the keyboard
 * shrank to nothing could never be selected or grown again, since there would be nothing left to
 * focus. Zero-extent shapes (which the parser rejects, but a corrupt row could still reach) are
 * returned untouched rather than scaled by infinity.
 */
function resizeBy(
  geometry: RegionGeometry,
  dx: number,
  dy: number,
  naturalWidth: number,
  naturalHeight: number,
): RegionGeometry {
  const bounds = boundsOf(geometry, naturalWidth, naturalHeight);
  const w = Math.max(bounds.w + dx, MIN_REGION_SIZE);
  const h = Math.max(bounds.h + dy, MIN_REGION_SIZE);

  switch (geometry.shape) {
    case 'rect':
      return { ...geometry, w, h };

    case 'circle': {
      // One degree of freedom: only one arrow is non-zero, so the sum *is* that arrow.
      const r = Math.max(geometry.r + dx + dy, MIN_REGION_SIZE / 2);
      const grown: RegionGeometry = { ...geometry, r };
      // Re-anchor so the bounding box's top-left corner stays where it was.
      const after = boundsOf(grown, naturalWidth, naturalHeight);
      return translate(grown, bounds.x - after.x, bounds.y - after.y);
    }

    case 'polygon': {
      if (bounds.w <= 0 || bounds.h <= 0) return geometry;
      const sx = w / bounds.w;
      const sy = h / bounds.h;
      return {
        shape: 'polygon',
        points: geometry.points.map((p) => ({
          x: bounds.x + (p.x - bounds.x) * sx,
          y: bounds.y + (p.y - bounds.y) * sy,
        })),
      };
    }
  }
}

/**
 * Apply a resolved `nudge` or `resize` to a shape, returning the new geometry clamped into the
 * image. `activate` and `cancel` carry no geometry change and return the shape unaltered, so a
 * caller can pass any action through without re-narrowing it.
 *
 * The result always goes through {@link clampGeometry}, so a region nudged at the edge parks
 * against it rather than sliding off the photo — the same rule the pointer path commits under.
 */
export function applyRegionKey(
  geometry: RegionGeometry,
  action: RegionKeyAction,
  naturalWidth = 1,
  naturalHeight = 1,
): RegionGeometry {
  switch (action.kind) {
    case 'nudge':
      return clampGeometry(translate(geometry, action.dx, action.dy), naturalWidth, naturalHeight);
    case 'resize':
      return clampGeometry(
        resizeBy(geometry, action.dx, action.dy, naturalWidth, naturalHeight),
        naturalWidth,
        naturalHeight,
      );
    case 'activate':
    case 'cancel':
      return geometry;
  }
}
