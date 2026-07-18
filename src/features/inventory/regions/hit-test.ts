/**
 * Pure hit-testing for location-photo regions (issue #81) — "which region did the user click?",
 * answered from normalised coordinates alone.
 *
 * The browser could answer this for us via `elementFromPoint` over the SVG overlay, and the
 * rendered overlay still gets native pointer events for the common case. But that path is
 * untestable — **jsdom has no `elementFromPoint` at all** and `getBoundingClientRect` returns
 * zeros — and it cannot answer the questions the keyboard and list affordances need ("what is
 * under this coordinate?" without a pointer). Doing the maths here keeps every containment rule
 * exhaustively unit-tested and identical on both paths.
 */

import { boundsOf, circleRadii, type NormalisedPoint, type RegionGeometry } from './geometry';

/**
 * Tolerance, in normalised units, for treating a point as lying *on* a shape's boundary. Well
 * below a rendered pixel at any realistic display size, so it only absorbs floating-point error
 * rather than widening the shape.
 */
export const EDGE_EPSILON = 1e-9;

/** The shape of a region row this module needs: its geometry and its z-order. */
export interface HitTestRegion {
  readonly geometry: RegionGeometry;
  /** Stacking order — the `position` column. Higher sits on top. */
  readonly position: number;
}

/** Whether a normalised point lies inside (or exactly on the edge of) an axis-aligned rectangle. */
function pointInRect(point: NormalisedPoint, x: number, y: number, w: number, h: number): boolean {
  return (
    point.x >= x - EDGE_EPSILON &&
    point.x <= x + w + EDGE_EPSILON &&
    point.y >= y - EDGE_EPSILON &&
    point.y <= y + h + EDGE_EPSILON
  );
}

/**
 * Whether a normalised point lies inside the ellipse a circle region renders as.
 *
 * The test is the standard `(dx/rx)² + (dy/ry)² ≤ 1`, with the semi-axes coming from
 * {@link circleRadii} — *not* from `r` applied to both axes, which would test a circle in
 * normalised space and so mismatch the ellipse actually drawn on a non-square photo. Getting this
 * wrong is invisible on a square test image and wrong on every real one.
 */
function pointInCircle(
  point: NormalisedPoint,
  cx: number,
  cy: number,
  r: number,
  naturalWidth: number,
  naturalHeight: number,
): boolean {
  const { rx, ry } = circleRadii(r, naturalWidth, naturalHeight);
  if (rx <= 0 || ry <= 0) return false;
  const dx = (point.x - cx) / rx;
  const dy = (point.y - cy) / ry;
  return dx * dx + dy * dy <= 1 + EDGE_EPSILON;
}

/** Whether `point` lies on the segment `a`–`b` (within {@link EDGE_EPSILON}). */
function pointOnSegment(point: NormalisedPoint, a: NormalisedPoint, b: NormalisedPoint): boolean {
  // Off the line entirely? (twice the triangle area, i.e. the cross product.)
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  if (Math.abs(cross) > EDGE_EPSILON) return false;
  // On the line — but within the segment's span?
  return (
    point.x >= Math.min(a.x, b.x) - EDGE_EPSILON &&
    point.x <= Math.max(a.x, b.x) + EDGE_EPSILON &&
    point.y >= Math.min(a.y, b.y) - EDGE_EPSILON &&
    point.y <= Math.max(a.y, b.y) + EDGE_EPSILON
  );
}

/**
 * Whether a normalised point lies inside a polygon, by **even-odd** ray casting: a ray is cast in
 * +x from the point and the crossings of the polygon's edges are counted; an odd count is inside.
 * This handles **concave** polygons correctly (a convex-only test such as "same side of every
 * edge" would wrongly report the notch of an L-shape as inside), and matches the SVG default
 * `fill-rule: evenodd` the overlay renders with, so what looks filled is what is hit.
 *
 * **The boundary convention: a point exactly on an edge or vertex is INSIDE.** Ray casting alone
 * cannot promise that — the half-open `(yi > y) !== (yj > y)` crossing rule it depends on to avoid
 * double-counting a shared vertex makes the *top* edge of a shape inside and the *bottom* edge
 * outside, which is consistent but arbitrary, and it is numerically unstable for a point sitting
 * exactly on a near-horizontal edge. Since a user who clicks precisely on a region's outline
 * plainly means to select that region, the edges are tested explicitly first and the ray cast only
 * decides genuine interior points.
 */
function pointInPolygon(point: NormalisedPoint, points: readonly NormalisedPoint[]): boolean {
  if (points.length < 3) return false;

  // The boundary is inside, by convention — and settling it here keeps the ray cast off the
  // degenerate cases it is least reliable for.
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    if (pointOnSegment(point, points[j]!, points[i]!)) return true;
  }

  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!;
    const b = points[i]!;
    // Count a crossing only when the edge spans the ray's row half-openly, so a vertex shared by
    // two edges is counted once rather than twice.
    if (b.y > point.y !== a.y > point.y) {
      const t = (point.y - b.y) / (a.y - b.y);
      if (point.x < b.x + t * (a.x - b.x)) inside = !inside;
    }
  }
  return inside;
}

/** Whether a normalised point lies inside (or exactly on the boundary of) a single shape. */
export function geometryContains(
  geometry: RegionGeometry,
  point: NormalisedPoint,
  naturalWidth = 1,
  naturalHeight = 1,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;

  // Cheap rejection first: the bounding box excludes the great majority of misses for the cost of
  // four comparisons, before any square root or ray cast.
  const bounds = boundsOf(geometry, naturalWidth, naturalHeight);
  if (!pointInRect(point, bounds.x, bounds.y, bounds.w, bounds.h)) return false;

  switch (geometry.shape) {
    case 'rect':
      return true; // the shape *is* its bounding box — the pre-filter was the exact test
    case 'circle':
      return pointInCircle(point, geometry.cx, geometry.cy, geometry.r, naturalWidth, naturalHeight);
    case 'polygon':
      return pointInPolygon(point, geometry.points);
  }
}

/**
 * The **topmost** region containing a normalised point, or `null` when the point is over bare
 * photo.
 *
 * Regions resolve in **z-order: `position` descending**, so the region drawn last (on top) is the
 * one a click on an overlap selects — matching what the user can actually see. Ties on `position`
 * — which the schema permits, since `position` is a plain `INTEGER DEFAULT 0` with no unique
 * constraint — are broken by **later array order first**, mirroring painter's-algorithm rendering
 * where the last shape drawn wins. The result is deterministic for any input rather than dependent
 * on sort stability.
 *
 * Generic over the caller's row type so a repository row can be passed straight in and the matched
 * row (not just its geometry) comes back.
 */
export function hitTest<T extends HitTestRegion>(
  regions: readonly T[],
  point: NormalisedPoint,
  naturalWidth = 1,
  naturalHeight = 1,
): T | null {
  const ordered = regions
    .map((region, index) => ({ region, index }))
    .sort((a, b) => b.region.position - a.region.position || b.index - a.index);

  for (const { region } of ordered) {
    if (geometryContains(region.geometry, point, naturalWidth, naturalHeight)) return region;
  }
  return null;
}
