/**
 * Pure coordinate maths for location-photo **regions** (issue #81) — the letterbox transform,
 * the circle aspect correction, bounds, clamping and the JSON (de)serialisation the `geometry`
 * TEXT column round-trips through.
 *
 * Region geometry is stored in **normalised image space** (0–1 per axis) so re-encoding a photo
 * at a different size never moves its regions. Rendering therefore needs two things this module
 * owns:
 *
 * 1. **The `object-contain` letterbox transform** ({@link containBox}). A photo being *drawn on*
 *    must be shown whole, so the display box is filled with `Math.min` scale and centred, leaving
 *    bars on the shorter axis. This is the exact inverse of the scanner's `roi.ts`, which does
 *    `object-cover` (`Math.max` scale, cropping the overflow) because a viewfinder must fill the
 *    screen rather than show the whole frame.
 * 2. **The circle aspect correction** ({@link circleRadii}). `x`/`y` are each normalised against
 *    their *own* axis, which is right for rectangles and polygons but would render a circle as an
 *    *ellipse* on a non-square photo. So `r` is normalised against the image **width only** and
 *    the vertical radius is derived — see {@link circleRadii}.
 *
 * Everything here takes plain numbers and rectangles and never touches the DOM: under **jsdom**
 * `getBoundingClientRect` returns zeros and `elementFromPoint` does not exist, so maths that read
 * layout could not be unit-tested at all. The DOM glue (measuring the `<img>`, binding pointer
 * events) lives with the `RegionCanvas` component.
 */

import type { RegionShape } from '../../../db/repositories/constants';

/** A point in normalised image space: `x` is 0–1 of the width, `y` is 0–1 of the height. */
export interface NormalisedPoint {
  readonly x: number;
  readonly y: number;
}

/** A point in displayed (CSS-pixel) space, relative to the display box's own origin. */
export interface DisplayPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A displayed (CSS-pixel) rectangle — the rendered **content box** of an `object-contain` image,
 * expressed relative to the display box's own top-left corner (so `left`/`top` are the letterbox
 * bar sizes, and are 0 on the axis that is fully filled).
 */
export interface DisplayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** An axis-aligned rectangle region: normalised top-left plus normalised size. */
export interface RectGeometry {
  readonly shape: 'rect';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * A circular region: normalised centre plus a radius normalised against the image **width only**
 * (see {@link circleRadii} for why, and for the derived vertical radius).
 */
export interface CircleGeometry {
  readonly shape: 'circle';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/** A polygonal region: three or more normalised vertices, in winding order. */
export interface PolygonGeometry {
  readonly shape: 'polygon';
  readonly points: readonly NormalisedPoint[];
}

/** A region's geometry, discriminated by the `shape` column it is stored beside. */
export type RegionGeometry = RectGeometry | CircleGeometry | PolygonGeometry;

/** A normalised axis-aligned bounding box, as returned by {@link boundsOf}. */
export interface NormalisedBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The fewest vertices a polygon may have — below this it encloses no area. */
export const MIN_POLYGON_POINTS = 3;

/**
 * The most vertices {@link parseGeometry} will accept. Geometry can arrive from a corrupt row or
 * a peer device, so a sanity bound keeps a malformed payload from turning into an unbounded loop
 * in the hit-test; it is far above any hand-drawn shape.
 */
export const MAX_POLYGON_POINTS = 512;

/** Every value is a real, finite number (a missing field arrives as `undefined`). */
function allFinite(values: readonly unknown[]): boolean {
  return values.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** A single untrusted field as a finite number, or `null` — the parser's one narrowing primitive. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Clamp `n` into `[min, max]`. */
function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/**
 * The centred, letterboxed content rectangle an `object-contain` image occupies inside a display
 * box of `boxWidth` × `boxHeight`, in CSS pixels relative to that box's top-left corner.
 *
 * The image is scaled by `Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight)` so it fits
 * *whole*, then centred — leaving equal bars on whichever axis is over-long. Returns `null` when
 * any input is not a positive finite number: an unlaid-out element reports 0 (as it does under
 * jsdom), and an image whose intrinsic size has not resolved reports 0 too. Callers treat `null`
 * as "nothing to render yet" rather than dividing by zero.
 */
export function containBox(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
): DisplayBox | null {
  if (!allFinite([naturalWidth, naturalHeight, boxWidth, boxHeight])) return null;
  if (![naturalWidth, naturalHeight, boxWidth, boxHeight].every((n) => n > 0)) return null;

  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  if (!(scale > 0)) return null;

  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: (boxWidth - width) / 2,
    top: (boxHeight - height) / 2,
    width,
    height,
  };
}

/**
 * Map a normalised point onto the rendered content box, giving CSS pixels relative to the display
 * box's origin. The exact inverse of {@link displayToNormalised}.
 */
export function normalisedToDisplay(point: NormalisedPoint, content: DisplayBox): DisplayPoint {
  return {
    x: content.left + point.x * content.width,
    y: content.top + point.y * content.height,
  };
}

/**
 * Map a CSS-pixel point (relative to the display box's origin) back into normalised image space.
 * The exact inverse of {@link normalisedToDisplay}.
 *
 * The result is **not** clamped: a pointer dragged onto the letterbox bars legitimately reports a
 * value outside 0–1, and it is {@link clampGeometry} — at commit time — that decides what to do
 * about it. A degenerate (zero-sized) content box maps everything to 0, since there is no scale to
 * invert.
 */
export function displayToNormalised(point: DisplayPoint, content: DisplayBox): NormalisedPoint {
  return {
    x: content.width > 0 ? (point.x - content.left) / content.width : 0,
    y: content.height > 0 ? (point.y - content.top) / content.height : 0,
  };
}

/** A circle's normalised semi-axes, as {@link circleRadii} resolves them. */
export interface CircleRadii {
  /** Horizontal radius, in units of the image width. Always exactly `r`. */
  readonly rx: number;
  /** Vertical radius, in units of the image *height*. */
  readonly ry: number;
}

/**
 * Resolve a stored circle radius into the pair of normalised semi-axes that render as a **visual
 * circle** at any display size.
 *
 * Because `x` and `y` are each normalised against their own axis, a radius applied unchanged to
 * both would be stretched by the image's aspect ratio — a 4:3 photo would show every circle as a
 * wide ellipse. `r` is therefore defined as a fraction of the image **width**, and the vertical
 * radius is the same physical distance re-expressed as a fraction of the height:
 *
 * ```
 * rx = r
 * ry = r * (naturalWidth / naturalHeight)
 * ```
 *
 * On a **wide** photo (width > height) `ry > rx` in normalised units — the circle spans a greater
 * *fraction* of the shorter axis — and on a **tall** photo the reverse. Multiplied back out by the
 * rendered content box, which preserves the aspect ratio, both come to the same number of CSS
 * pixels.
 *
 * Non-finite or non-positive dimensions fall back to a square image (`ry === rx`), which is the
 * only correction that can be justified without knowing the aspect ratio.
 */
export function circleRadii(r: number, naturalWidth: number, naturalHeight: number): CircleRadii {
  if (!allFinite([r, naturalWidth, naturalHeight]) || naturalWidth <= 0 || naturalHeight <= 0) {
    const safe = Number.isFinite(r) ? r : 0;
    return { rx: safe, ry: safe };
  }
  return { rx: r, ry: r * (naturalWidth / naturalHeight) };
}

/**
 * The normalised axis-aligned bounding box of any shape — the cheap pre-filter the hit-test runs
 * before its exact containment maths, and the rectangle a "scroll the selected region into view"
 * affordance focuses.
 *
 * The natural dimensions are only consulted for a **circle**, whose vertical extent depends on the
 * aspect ratio (see {@link circleRadii}); they default to a square image, for which the correction
 * is the identity, so a caller working purely in rect/polygon space may omit them.
 *
 * The box is the shape's true mathematical extent and is deliberately **not** clamped to 0–1: a
 * shape that overhangs the image should report that it does, rather than silently claiming to end
 * at the edge.
 */
export function boundsOf(geometry: RegionGeometry, naturalWidth = 1, naturalHeight = 1): NormalisedBounds {
  switch (geometry.shape) {
    case 'rect':
      return { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h };

    case 'circle': {
      const { rx, ry } = circleRadii(geometry.r, naturalWidth, naturalHeight);
      return { x: geometry.cx - rx, y: geometry.cy - ry, w: rx * 2, h: ry * 2 };
    }

    case 'polygon': {
      const xs = geometry.points.map((p) => p.x);
      const ys = geometry.points.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
  }
}

/**
 * Bring a shape back inside the 0–1 image, **preferring translation to distortion**.
 *
 * The semantics, chosen deliberately and applied uniformly to all three shapes:
 *
 * - **If the shape already fits within the image, it is only moved.** Its size and proportions are
 *   preserved exactly, and it is slid the shortest distance that puts it inside. A user who drags
 *   a region off the edge gets the region they drew, parked against the edge — not a squashed one.
 * - **Only a shape too large to fit is resized**, and then no more than necessary: a rectangle's
 *   size is capped at the image size, a circle's radius is reduced to the largest that fits *both*
 *   axes (respecting the aspect correction, so it stays a circle rather than becoming an ellipse),
 *   and a polygon — which has no single "size" to scale without choosing an anchor — has its
 *   vertices clamped individually. Clamping is the distorting case; it is confined to the polygon
 *   that genuinely cannot be translated into range.
 * - **Non-finite coordinates are treated as 0**, so corrupt input yields a degenerate but valid
 *   shape rather than propagating `NaN` into the renderer.
 *
 * The natural dimensions are needed for the circle's vertical extent; they default to a square
 * image exactly as in {@link boundsOf}.
 */
export function clampGeometry(geometry: RegionGeometry, naturalWidth = 1, naturalHeight = 1): RegionGeometry {
  const safe = (n: number) => (Number.isFinite(n) ? n : 0);

  switch (geometry.shape) {
    case 'rect': {
      const w = clamp(safe(geometry.w), 0, 1);
      const h = clamp(safe(geometry.h), 0, 1);
      return {
        shape: 'rect',
        x: clamp(safe(geometry.x), 0, 1 - w),
        y: clamp(safe(geometry.y), 0, 1 - h),
        w,
        h,
      };
    }

    case 'circle': {
      const aspect =
        allFinite([naturalWidth, naturalHeight]) && naturalHeight > 0 && naturalWidth > 0
          ? naturalWidth / naturalHeight
          : 1;
      // The largest width-normalised radius whose horizontal *and* vertical extent still fit.
      const maxR = Math.min(0.5, 0.5 / aspect);
      const r = clamp(safe(geometry.r), 0, maxR);
      const { rx, ry } = circleRadii(r, naturalWidth, naturalHeight);
      return {
        shape: 'circle',
        cx: clamp(safe(geometry.cx), rx, 1 - rx),
        cy: clamp(safe(geometry.cy), ry, 1 - ry),
        r,
      };
    }

    case 'polygon': {
      const points = geometry.points.map((p) => ({ x: safe(p.x), y: safe(p.y) }));
      const bounds = boundsOf({ shape: 'polygon', points });
      if (bounds.w <= 1 && bounds.h <= 1) {
        // Fits: translate by the shortest offset that puts every vertex in range.
        const dx = clamp(bounds.x, 0, 1 - bounds.w) - bounds.x;
        const dy = clamp(bounds.y, 0, 1 - bounds.h) - bounds.y;
        return { shape: 'polygon', points: points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      }
      // Too large to translate into range — clamp each vertex, accepting the distortion.
      return {
        shape: 'polygon',
        points: points.map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) })),
      };
    }
  }
}

/**
 * Parse the `geometry` JSON TEXT column into a typed shape, or `null` when it is not valid for
 * `shape`.
 *
 * This is a **trust boundary**: the value may have been written by an older build, corrupted in
 * storage, or merged in from a peer device, so every field is checked rather than asserted — a
 * wrong or missing discriminator, a missing or non-finite number, a non-positive size, a polygon
 * with fewer than {@link MIN_POLYGON_POINTS} or more than {@link MAX_POLYGON_POINTS} vertices, and
 * malformed JSON all return `null`. It never throws, so a single bad row degrades to "that region
 * does not render" instead of taking the screen down.
 *
 * The `shape` discriminator lives in its own column, so it is **not** part of the stored JSON; it
 * is passed in and woven into the returned value.
 */
export function parseGeometry(json: string, shape: RegionShape): RegionGeometry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  switch (shape) {
    case 'rect': {
      const x = asNumber(value.x);
      const y = asNumber(value.y);
      const w = asNumber(value.w);
      const h = asNumber(value.h);
      if (x === null || y === null || w === null || h === null) return null;
      if (w <= 0 || h <= 0) return null; // a zero/negative-sized rect encloses nothing
      return { shape: 'rect', x, y, w, h };
    }

    case 'circle': {
      const cx = asNumber(value.cx);
      const cy = asNumber(value.cy);
      const r = asNumber(value.r);
      if (cx === null || cy === null || r === null) return null;
      if (r <= 0) return null; // a zero/negative radius encloses nothing
      return { shape: 'circle', cx, cy, r };
    }

    case 'polygon': {
      const { points } = value;
      if (!Array.isArray(points)) return null;
      if (points.length < MIN_POLYGON_POINTS || points.length > MAX_POLYGON_POINTS) return null;
      const parsed: NormalisedPoint[] = [];
      for (const point of points as readonly unknown[]) {
        if (typeof point !== 'object' || point === null) return null;
        const x = asNumber((point as Record<string, unknown>).x);
        const y = asNumber((point as Record<string, unknown>).y);
        if (x === null || y === null) return null;
        parsed.push({ x, y });
      }
      return { shape: 'polygon', points: parsed };
    }

    default:
      return null;
  }
}

/**
 * Serialise a shape for the `geometry` TEXT column. The `shape` discriminator is **omitted** — it
 * is stored in its own column (and CHECK-constrained there), so duplicating it in the JSON would
 * create a second source of truth that could drift. {@link parseGeometry} reads it back from the
 * column.
 */
export function serialiseGeometry(geometry: RegionGeometry): string {
  switch (geometry.shape) {
    case 'rect':
      return JSON.stringify({ x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h });
    case 'circle':
      return JSON.stringify({ cx: geometry.cx, cy: geometry.cy, r: geometry.r });
    case 'polygon':
      return JSON.stringify({ points: geometry.points.map((p) => ({ x: p.x, y: p.y })) });
  }
}
