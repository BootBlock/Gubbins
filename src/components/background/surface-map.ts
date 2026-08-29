/**
 * surface-map — the "where can precipitation land?" lookup table behind the weather layer's
 * control interaction (issue #68: snow settles on controls, rain splashes off their tops).
 *
 * The viewport is divided into fixed-width columns and, for each column, the map records the
 * y of the **topmost control edge** a falling particle would hit — a single `Int16Array` the
 * engine indexes with `x / COLUMN_WIDTH` per particle per frame. That one-array-lookup design is
 * deliberate: the engine's collision test must be O(1) and allocation-free, so all the DOM cost
 * (querying candidate controls and reading their rects) happens *here*, rarely — debounced,
 * batched and frame-aligned — never in the frame loop.
 *
 * Two halves:
 *  - **Pure:** {@link buildSurfaceMap} folds a set of rects into the column map (topmost edge
 *    wins, matching how snow actually falls: whatever is under cover stays clear). Unit-testable
 *    with plain numbers.
 *  - **DOM:** {@link trackSurfaces} owns the live map — it collects on-screen control rects
 *    (buttons, inputs, cards…) and rebuilds the map on scroll / resize / DOM mutation, bumping a
 *    generation counter only when the map actually changed so the engine can cheaply detect "the
 *    world moved" and reconcile its settled snow.
 *
 * Rebuild cost control, because a decorative layer must never become a standing tax:
 *  - Triggers are **trailing-debounced** ({@link REBUILD_DEBOUNCE_MS}) so a scroll or a burst of
 *    list churn produces one rebuild at rest, not a rebuild storm mid-gesture — with a hard cap
 *    ({@link REBUILD_MAX_LATENCY_MS}) so a *continuous* storm can't keep the map stale forever.
 *    A scroll needs no rebuild to be followed, though: a *page* scroll moves every mapped
 *    surface by the same amount, and an *inner container's* scroll moves the surfaces over its
 *    own columns. {@link SurfaceTracker.scrollShift} reports both live and for free, so the
 *    consumer can ride them at frame rate while the rebuild takes its time (issues #438, #716).
 *  - The rebuild itself runs inside `requestAnimationFrame`, so its one batched layout read
 *    lands at a frame boundary instead of an arbitrary timer tick.
 *  - Nothing runs while the tab is **hidden** (the consuming engine is paused then anyway); a
 *    rebuild is requested on return to visibility.
 *  - The scan is scoped to the app root (`#root`), which *structurally* excludes every portalled
 *    floating layer (modals, menus, toasts, tooltips, the scanner overlay — they portal to
 *    `document.body`); the exclusion selector below is only a second line of defence for
 *    in-root layers.
 *
 * The map is a heuristic by design — it reads geometric rects, not real occlusion — which is the
 * right trade for a decorative layer: cheap, robust, and wrong only in glancing edge cases (e.g.
 * a card sliding under a sticky header) that resolve themselves on the next rebuild.
 */

import { HOVER_NONE_QUERY } from '@/lib/env/device';

/** Width of one lookup column in css px. Small enough for mound curves, few enough to stay tiny. */
export const COLUMN_WIDTH = 4;

/** Sentinel meaning "no control surface in this column" (fits Int16, above any viewport y). */
export const NO_SURFACE = 0x7fff;

/** Minimum on-screen size for an element to count as a landable surface (css px). */
const MIN_SURFACE_WIDTH = 24;
const MIN_SURFACE_HEIGHT = 12;

/** Trailing debounce: a rebuild runs after this much trigger quiet (ms). */
const REBUILD_DEBOUNCE_MS = 150;

/** A continuous trigger storm may defer a pending rebuild at most this long (ms). */
const REBUILD_MAX_LATENCY_MS = 600;

/** Safety-net rebuild period (ms) for layout shifts no observer catches (fonts, images, class
 *  toggles — attribute mutations are deliberately not observed, see {@link trackSurfaces}). */
const PERIODIC_REBUILD_MS = 2000;

/** How long the hover-follow poll keeps reading after a pointer transition (ms): long enough to
 *  ride a control's ~200ms lift/release animation, after which it idles (see {@link trackSurfaces}). */
const HOVER_FOLLOW_MS = 350;

/** Upper bound on collected rects per rebuild, so a huge screen can't make the scan expensive. */
const MAX_SURFACES = 400;

/** The interactive primitives, plus the explicit opt-in for anything else. */
const CONTROL_SELECTOR = 'button, input, select, textarea, [data-precip-surface]';

/**
 * What counts as a "control" snow can settle on: the interactive primitives plus card surfaces.
 * `[class*="bg-card"]` is only a fast pre-filter — a candidate that matched solely on it must
 * still pass {@link hasRestingCardSurface}, so state-variant utilities (`hover:bg-card/60` on an
 * at-rest-transparent table row) don't register a surface that isn't visibly there.
 */
const SURFACE_SELECTOR = `${CONTROL_SELECTOR}, [class*="bg-card"]`;

/**
 * In-root layers precipitation must still ignore (portalled layers never enter the scan at all):
 * inline alert/status chrome, non-portalled dialogs, and anything inside a hidden subtree.
 */
const EXCLUDED_ANCESTOR_SELECTOR =
  '[role="dialog"], [role="alert"], [role="status"], [class*="bg-popover"], [aria-hidden="true"]';

/**
 * A control's landable extent: its top edge between `left` and `right`, with the top corner radii
 * so the map can follow a rounded corner's arc instead of shelving flatly across it, plus its
 * bottom edge so wind-blown snow can catch on the underside lip (all css px).
 */
export interface SurfaceRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** Top-left / top-right border radius (0 = square corner). */
  readonly radiusLeft: number;
  readonly radiusRight: number;
}

/** The per-column top and bottom edges of the topmost control, as parallel arrays. */
export interface SurfaceMaps {
  readonly tops: Int16Array;
  readonly bots: Int16Array;
}

/** The current maps plus a change counter (bumped only when the content changed). */
export interface SurfaceSnapshot {
  /** Per-column y of the topmost control edge, or {@link NO_SURFACE}. Swapped, never mutated. */
  readonly tops: Int16Array;
  /**
   * Per-column y of that same control's bottom edge, or {@link NO_SURFACE} where there is no
   * surface or the bottom sits below the fold (an off-screen underside has nothing to show).
   */
  readonly bots: Int16Array;
  /**
   * The page scroll offset (css px) the maps were built at. Paired with the live scroll position
   * it gives {@link SurfaceTracker.scrollShift} — how far the mapped surfaces have moved since —
   * so a consumer can follow a scroll at frame rate instead of waiting for the next rebuild.
   */
  readonly scrollY: number;
  /**
   * Identity of the inner scroll container being followed (issue #716), or 0 for none. A fresh
   * id is issued whenever the tracked container changes, so a consumer can tell "the same
   * container, scrolled further" — where {@link innerTop} is a comparable baseline — from "a
   * different container", where it is not.
   */
  readonly innerId: number;
  /** That container's own `scrollTop` (css px) when the maps were built. */
  readonly innerTop: number;
  /** First / last column (inclusive) the container spans; -1 / -1 when there is none. */
  readonly innerC0: number;
  readonly innerC1: number;
  readonly generation: number;
}

/**
 * How far the published map's surfaces have moved on screen since it was built, because
 * something scrolled under them (issues #438, #716). Two independent parts, because the two
 * scrolls compose: the page carries every column, and an inner container carries its own columns
 * further still. Negative when the surfaces moved *up* the screen.
 */
export interface ScrollShift {
  /** Applies to every column — the page scrolled. */
  readonly page: number;
  /** Applies on top of {@link page}, for columns {@link c0}…{@link c1} only. 0 when none. */
  readonly inner: number;
  /** First / last column (inclusive) {@link inner} applies to; -1 / -1 when it is 0. */
  readonly c0: number;
  readonly c1: number;
}

/**
 * The live vertical offset of the surface the pointer is over (issue #68 follow-up). A control's
 * hover response is a compositor `transform` (e.g. an item card lifts a few px on hover) that
 * fires no scroll/resize/mutation, so the *map* deliberately ignores it — the map records the
 * un-transformed layout top, staying stable so the lift never knocks settled snow off. This is
 * how the settled snow is told to ride along with the lift instead: the columns the hovered
 * control spans, and its current transform offset `dy` (negative = lifted up). Polled off the
 * particle loop; `null` when nothing landable is hovered.
 */
export interface HoverFollow {
  /** First / last column (inclusive) the hovered control spans. */
  readonly c0: number;
  readonly c1: number;
  /** The control's current transform translateY in css px (0 at rest, negative when lifted). */
  readonly dy: number;
}

/** Live handle created by the engine (via its `surfaces` factory) and read every frame. */
export interface SurfaceTracker {
  snapshot(): SurfaceSnapshot;
  /** The surface currently under the pointer and its live lift, or null. See {@link HoverFollow}. */
  hoverFollow(): HoverFollow | null;
  /**
   * How far the published map's surfaces have moved on screen since it was built, because
   * something scrolled under them. Live: it updates on the scroll event itself, so a consumer
   * can draw settled snow on a scrolling page — or in a scrolling list — at frame rate rather
   * than leaving it behind until the debounced rebuild catches up (issues #438, #716). Reads
   * values cached by the scroll listener, so it costs no layout, and returns one stable object
   * mutated in place so a per-frame read allocates nothing.
   *
   * Two limits, both self-correcting at the next rebuild. A container is followed only from the
   * *second* scroll event that reaches it, because the first is what establishes which container
   * to follow — until then it behaves as it did before #716. And a surface that sits over the
   * container's columns without being inside it (a heading above the list), or a
   * `position: fixed` surface under a page scroll, rides a shift it should not.
   */
  scrollShift(): ScrollShift;
  /** Detach every listener/observer (idempotent). */
  stop(): void;
}

/**
 * The vertical translate component (css px) of an element's current transform — its hover lift.
 * `DOMMatrixReadOnly.m42` is the composed translateY, so it captures the lift even when a tilt or
 * other transform composes with it. Returns 0 for an untransformed element or where unsupported.
 */
function transformOffsetY(el: Element): number {
  if (typeof getComputedStyle !== 'function') return 0;
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  try {
    return new DOMMatrixReadOnly(t).m42;
  } catch {
    return 0;
  }
}

/** The quarter-circle corner drop: edge y at horizontal distance `d` from the arc's centre. */
function arcTop(top: number, radius: number, d: number): number {
  return top + radius - Math.sqrt(Math.max(0, radius * radius - d * d));
}

/**
 * The visible top edge of `r` at horizontal position `x`, following the rounded top corners:
 * inside a corner radius the edge is the quarter-circle arc {@link arcTop}, flat in between.
 * This is what stops snow shelving horizontally across a card's rounded corner — the surface the
 * map reports curves down exactly where the drawn corner does.
 */
function surfaceTopAt(r: SurfaceRect, x: number): number {
  const fromLeft = x - r.left;
  if (fromLeft < r.radiusLeft) return arcTop(r.top, r.radiusLeft, r.radiusLeft - fromLeft);
  const fromRight = r.right - x;
  if (fromRight < r.radiusRight) return arcTop(r.top, r.radiusRight, r.radiusRight - fromRight);
  return r.top;
}

/**
 * Fold `rects` into per-column topmost-edge maps, sampling each rect's corner-aware top profile
 * at the column centre. A rect only registers if its top edge is actually inside the viewport —
 * an element scrolled partly off the top has no visible top edge to land on. `bots` records the
 * winning (topmost) control's bottom edge per column — the underside lip snow can catch on —
 * or {@link NO_SURFACE} when that bottom sits below the fold. Pure; the DOM never enters here.
 */
export function buildSurfaceMap(
  rects: readonly SurfaceRect[],
  viewportWidth: number,
  viewportHeight: number,
  columnWidth: number = COLUMN_WIDTH,
): SurfaceMaps {
  const cols = Math.max(1, Math.ceil(viewportWidth / columnWidth));
  const tops = new Int16Array(cols).fill(NO_SURFACE);
  const bots = new Int16Array(cols).fill(NO_SURFACE);
  for (const r of rects) {
    if (r.top < 0 || r.top >= viewportHeight) continue;
    if (r.right <= 0 || r.left >= viewportWidth) continue;
    const first = Math.max(0, Math.floor(r.left / columnWidth));
    const last = Math.min(cols - 1, Math.floor((r.right - 1) / columnWidth));
    for (let c = first; c <= last; c++) {
      // Sample the profile at the column centre, clamped inside the rect for edge columns.
      const x = Math.min(Math.max(c * columnWidth + columnWidth / 2, r.left), r.right - 0.01);
      const top = Math.round(surfaceTopAt(r, x));
      // A corner arc can dip below the fold even when the flat top is above it — keep the old
      // guarantee that every recorded top is on-screen.
      if (top >= viewportHeight) continue;
      if (top < (tops[c] ?? NO_SURFACE)) {
        tops[c] = top;
        const bottom = Math.round(r.bottom);
        bots[c] = bottom < viewportHeight ? bottom : NO_SURFACE;
      }
    }
  }
  return { tops, bots };
}

/**
 * Parse one computed border-radius longhand into a circular px radius. Percentages and
 * elliptical two-value radii don't fit the circular-arc model, so they fall back to a square
 * corner (the pre-arc behaviour) rather than mis-modelling the drawn edge.
 */
function parseRadiusPx(value: string): number {
  const v = value.trim();
  if (v.includes('%') || v.includes(' ')) return 0;
  return parseFloat(v) || 0;
}

/**
 * Resolve the *used* top corner radii the way CSS does: when the specified radii overflow the
 * box, every radius scales down by the worst side's overflow factor (this is what turns a
 * `rounded-full` pill's 9999px into height/2, and what lets a single 100px corner keep its full
 * size on a tall box). Pure, exported for tests.
 *
 * @internal Exported for unit tests only.
 */
export function resolveTopRadii(
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number,
  width: number,
  height: number,
): [number, number] {
  if (topLeft <= 0 && topRight <= 0) return [0, 0];
  // Sides with a zero radius sum divide to Infinity and drop out of the min.
  const f = Math.min(
    1,
    width / (topLeft + topRight),
    width / (bottomLeft + bottomRight),
    height / (topLeft + bottomLeft),
    height / (topRight + bottomRight),
  );
  return [topLeft * f, topRight * f];
}

/**
 * Parsed raw radius longhands per element, cached for the tracker's lifetime of the node —
 * computed style resolution is the expensive part of the scan, and an element's specified radii
 * essentially never change while it lives (a class toggle that re-rounds a control is the same
 * attribute-level staleness the tracker already accepts elsewhere). The used radii still track
 * the element's *current* size, because {@link resolveTopRadii} runs per rebuild.
 */
const rawRadiiCache = new WeakMap<Element, readonly [number, number, number, number]>();

function rawTopRadii(el: Element): readonly [number, number, number, number] {
  const cached = rawRadiiCache.get(el);
  if (cached) return cached;
  const cs = getComputedStyle(el);
  const parsed: readonly [number, number, number, number] = [
    parseRadiusPx(cs.borderTopLeftRadius),
    parseRadiusPx(cs.borderTopRightRadius),
    parseRadiusPx(cs.borderBottomLeftRadius),
    parseRadiusPx(cs.borderBottomRightRadius),
  ];
  rawRadiiCache.set(el, parsed);
  return parsed;
}

/**
 * Does the element carry a *resting* card background (`bg-card`, `bg-card/80`, …)? A state
 * variant such as `hover:bg-card/60` is a single class token starting with its modifier, so it
 * fails this check — the element is transparent at rest and nothing should land on it.
 */
function hasRestingCardSurface(el: Element): boolean {
  for (const cls of el.classList) {
    if (cls === 'bg-card' || cls.startsWith('bg-card/')) return true;
  }
  return false;
}

/**
 * Collect the on-screen control rects the map is built from (viewport coordinates). The
 * `hovered` element (if any) has its hover-lift transform subtracted back out, so the map records
 * its resting layout top — the lift is applied separately as a render-time follow ({@link
 * HoverFollow}) and must not perturb the persistent map (or a big lift would trip the reconcile
 * move-tolerance and knock the control's settled snow off).
 */
function collectControlRects(
  root: ParentNode,
  viewportWidth: number,
  viewportHeight: number,
  hovered: Element | null,
): SurfaceRect[] {
  const rects: SurfaceRect[] = [];
  const candidates = root.querySelectorAll(SURFACE_SELECTOR);
  for (const el of candidates) {
    if (rects.length >= MAX_SURFACES) break;
    if (!el.matches(CONTROL_SELECTOR) && !hasRestingCardSurface(el)) continue;
    if (el.closest(EXCLUDED_ANCESTOR_SELECTOR)) continue;
    // checkVisibility covers display/visibility/content-visibility in one native call where
    // supported; the rect-size filter below handles the rest (and the no-support fallback).
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_SURFACE_WIDTH || r.height < MIN_SURFACE_HEIGHT) continue;
    // Undo the hover lift for the hovered control so the map holds its resting position (the
    // bottom edge shifts with the same lift, so it gets the same correction).
    const lift = el === hovered ? transformOffsetY(el) : 0;
    const top = r.top - lift;
    if (top < 0 || top >= viewportHeight || r.right <= 0 || r.left >= viewportWidth) continue;
    // Top corner radii, so the map can follow rounded corners. The raw longhands are cached per
    // element (style resolution is the scan's expensive part); the CSS overflow scaling runs per
    // rebuild against the current size, so a pill's 9999px resolves to height/2 as drawn. The
    // read sits in the same write-free batch as the rect — one layout pass.
    const [rawTL, rawTR, rawBL, rawBR] = rawTopRadii(el);
    const [radiusLeft, radiusRight] = resolveTopRadii(rawTL, rawTR, rawBL, rawBR, r.width, r.height);
    rects.push({ left: r.left, top, right: r.right, bottom: r.bottom - lift, radiusLeft, radiusRight });
  }
  return rects;
}

/**
 * The page's current vertical scroll offset in css px. `document.scrollingElement` is the element
 * that actually scrolls the page in either box mode; `scrollY` is the fallback where there is no
 * document element to read (and 0 where neither exists, as in a non-DOM environment).
 */
function pageScrollY(): number {
  const el = typeof document !== 'undefined' ? document.scrollingElement : null;
  if (el) return el.scrollTop;
  return typeof scrollY === 'number' ? scrollY : 0;
}

/** Content equality for two maps (lengths differing counts as changed). */
function mapsEqual(a: Int16Array, b: Int16Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Start tracking the app root's control surfaces. Rebuilds are driven by scroll (captured, so
 * inner scroll containers count), resize, and a childList MutationObserver — attribute mutations
 * are deliberately not observed (class/style toggles fire constantly app-wide; the periodic tick
 * catches the rare attribute-only layout shift). See the header for the debounce/visibility
 * behaviour. Reads happen in one rAF-aligned batch per rebuild.
 */
export function trackSurfaces(): SurfaceTracker {
  const root: ParentNode = document.getElementById('root') ?? document.body;
  // One mutable snapshot, updated in place on change — the engine polls it every frame, so
  // handing out a stable object keeps the frame loop allocation-free.
  const snap = {
    tops: new Int16Array(0) as Int16Array,
    bots: new Int16Array(0) as Int16Array,
    scrollY: pageScrollY(),
    innerId: 0,
    innerTop: 0,
    innerC0: -1,
    innerC1: -1,
    generation: 0,
  };
  /** The live page scroll offset, refreshed by the scroll listener and at every rebuild. */
  let pageY = snap.scrollY;

  // ── Inner scroll container follow (issue #716) ───────────────────────────────────────────
  /** The container that scrolled most recently, or null while only the page has scrolled. */
  let innerEl: Element | null = null;
  /** Its identity for {@link SurfaceSnapshot.innerId}; a fresh value per container, 0 for none. */
  let innerId = 0;
  /** Source of those ids — monotonic, so a re-tracked container never reuses an old baseline. */
  let innerSeq = 0;
  /** Its live `scrollTop`, cached by the scroll listener exactly as {@link pageY} is. */
  let innerTop = 0;
  /** The columns it spans. Measured when it changes and at every rebuild — an inner scroll moves
   *  the container's *content*, never its own box, so it needs no re-measure per scroll event. */
  let innerC0 = -1;
  let innerC1 = -1;
  /** The stable object {@link SurfaceTracker.scrollShift} hands back, mutated in place. */
  const shift = { page: 0, inner: 0, c0: -1, c1: -1 };
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let firstRequestAt = 0;
  let stopped = false;

  // ── Hover follow (issue #68 follow-up) ───────────────────────────────────────────────────
  /** The control whose lift the poll is tracking (through hover *and* its release animation). */
  let hoverEl: Element | null = null;
  /** True while the pointer is actually over {@link hoverEl}; false once it has left (releasing). */
  let hovering = false;
  /** Its column span + live lift, recomputed by the poll; null when nothing landable is hovered. */
  let hover: HoverFollow | null = null;
  /** rAF handle for the poll that tracks the lift while a control is hovered (0 = not polling). */
  let hoverRaf = 0;
  /**
   * Timestamp (ms) until which the poll keeps reading the hovered control. Each pointer
   * transition (enter/leave/move onto a child) extends it by {@link HOVER_FOLLOW_MS} — long
   * enough to ride the ~200ms lift/release animation — after which the poll idles and simply
   * holds the last offset while the lift is static, so it is not a standing per-frame DOM read
   * for the whole time the pointer merely rests on a control.
   */
  let hoverPollUntil = 0;

  /**
   * Read the tracked container's column span, dropping it if it has left the document or sits
   * entirely off the left edge (where there are no columns for its shift to apply to).
   */
  function measureInner(): void {
    if (innerEl && !innerEl.isConnected) {
      innerEl = null;
      innerId = 0;
    }
    const r = innerEl ? innerEl.getBoundingClientRect() : null;
    if (!r || r.right <= 0) {
      innerC0 = -1;
      innerC1 = -1;
      return;
    }
    innerC0 = Math.max(0, Math.floor(r.left / COLUMN_WIDTH));
    innerC1 = Math.max(innerC0, Math.floor((r.right - 1) / COLUMN_WIDTH));
  }

  function rebuild(): void {
    if (stopped || document.hidden) return;
    // A control removed while its hover offset is being held (poll idle) has no other cleanup.
    if (hoverEl && !hoverEl.isConnected) {
      hoverEl = null;
      hover = null;
    }
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    // A rebuild may also be triggered by something that moved the page under us without a scroll
    // event of its own (a resize, a layout change), so re-read rather than trusting the cache.
    pageY = pageScrollY();
    measureInner();
    innerTop = innerEl ? innerEl.scrollTop : 0;
    const next = buildSurfaceMap(collectControlRects(root, w, h, hoverEl), w, h);
    // The published scroll offsets are the baseline of the published maps, so all of them are
    // adopted together: a scroll that left the maps byte-identical still counts as a change,
    // because it resets the shift a consumer is drawing with (issues #438, #716).
    const scrolled =
      pageY !== snap.scrollY ||
      innerId !== snap.innerId ||
      innerTop !== snap.innerTop ||
      innerC0 !== snap.innerC0 ||
      innerC1 !== snap.innerC1;
    if (!mapsEqual(next.tops, snap.tops) || !mapsEqual(next.bots, snap.bots) || scrolled) {
      snap.tops = next.tops;
      snap.bots = next.bots;
      snap.scrollY = pageY;
      snap.innerId = innerId;
      snap.innerTop = innerTop;
      snap.innerC0 = innerC0;
      snap.innerC1 = innerC1;
      snap.generation++;
    }
  }

  function fire(): void {
    timer = 0;
    // Align the batched layout reads with a frame boundary instead of an arbitrary timer tick.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => rebuild());
    else rebuild();
  }

  function request(): void {
    // Hidden tab: the consuming engine is paused and nothing reads the map — skip entirely;
    // the visibilitychange listener below requests a catch-up rebuild on return.
    if (stopped || document.hidden) return;
    const now = Date.now();
    if (!timer) {
      firstRequestAt = now;
    } else if (now - firstRequestAt >= REBUILD_MAX_LATENCY_MS) {
      // The storm has deferred the pending rebuild long enough — let it fire as scheduled.
      return;
    } else {
      clearTimeout(timer);
    }
    timer = setTimeout(fire, REBUILD_DEBOUNCE_MS);
  }

  function onVisibility(): void {
    if (!document.hidden) request();
  }

  /** The nearest landable control at/above `target`, or null (mirrors the collect-time filters). */
  function landableAncestor(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest(SURFACE_SELECTOR);
    if (!el || el.closest(EXCLUDED_ANCESTOR_SELECTOR)) return null;
    if (!el.matches(CONTROL_SELECTOR) && !hasRestingCardSurface(el)) return null;
    return el;
  }

  /**
   * Recompute the hovered control's live lift, on its own rAF (a single-element read, off the
   * particle loop). Runs each frame within the {@link hoverPollUntil} window after a pointer
   * transition — capturing the lift/release animation and any mouse movement — then idles,
   * holding the last offset while the control sits statically lifted (no per-frame read).
   */
  function pollHover(): void {
    hoverRaf = 0;
    if (stopped || !hoverEl) return;
    if (!hoverEl.isConnected) {
      hoverEl = null;
      hover = null;
      return;
    }
    const r = hoverEl.getBoundingClientRect();
    const dy = transformOffsetY(hoverEl);
    const c0 = Math.max(0, Math.floor(r.left / COLUMN_WIDTH));
    const c1 = Math.max(c0, Math.floor((r.right - 1) / COLUMN_WIDTH));
    hover = { c0, c1, dy };
    if (!hovering && Math.abs(dy) < 0.25) {
      // Released and fully back at rest — nothing left to follow.
      hoverEl = null;
      hover = null;
      return;
    }
    if (Date.now() < hoverPollUntil) {
      // Within the animation/movement window: keep following frame to frame.
      if (typeof requestAnimationFrame === 'function') hoverRaf = requestAnimationFrame(pollHover);
    } else if (!hovering) {
      // Window elapsed after leaving but the lift never settled (unexpected) — clear rather than
      // leave snow hanging lifted.
      hoverEl = null;
      hover = null;
    }
    // else: still hovering and the lift is static — idle, holding the current offset.
  }

  function startPoll(): void {
    hoverPollUntil = Date.now() + HOVER_FOLLOW_MS;
    if (!hoverRaf && typeof requestAnimationFrame === 'function') {
      hoverRaf = requestAnimationFrame(pollHover);
    }
  }

  function onPointerOver(e: Event): void {
    const el = landableAncestor(e.target);
    if (!el) return;
    hoverEl = el;
    hovering = true;
    startPoll();
  }

  function onPointerOut(e: Event): void {
    // Only react to the pointer actually leaving the tracked control (not moving between its
    // children); the poll then follows the release animation back down to rest.
    if (!hoverEl || hoverEl !== landableAncestor(e.target)) return;
    const to = (e as PointerEvent).relatedTarget;
    if (to instanceof Node && hoverEl.contains(to)) return;
    hovering = false;
    startPoll();
  }

  /**
   * Cache the scroll offset that moved, then request the rebuild. The cache is what makes
   * {@link SurfaceTracker.scrollShift} free to read every frame: the scroll event fires before
   * the frame it affects, so the value a frame reads is that frame's own (issue #438).
   *
   * A scroll of an inner container is not a page scroll — it moves only the surfaces inside that
   * container — so the two are cached separately and the container is tracked by identity
   * (issue #716). Only the most recently scrolled container is followed; where a second one
   * scrolls before the rebuild lands, the first reverts to unshifted until that rebuild, which
   * knocks its snow off as a layout change exactly as it did before #716.
   */
  function onScroll(e: Event): void {
    const t = e.target;
    // The page's own scroll is reported on `document` (or on the scrolling element itself).
    const el =
      t instanceof Element && t !== document.scrollingElement && t !== document.documentElement ? t : null;
    if (!el) {
      pageY = pageScrollY();
    } else {
      if (el !== innerEl) {
        innerEl = el;
        innerId = ++innerSeq;
        measureInner();
      }
      innerTop = el.scrollTop;
    }
    request();
  }

  // `scroll` does not bubble, but a capture listener still sees every inner container's scroll.
  addEventListener('scroll', onScroll, { capture: true, passive: true });
  addEventListener('resize', request);
  document.addEventListener('visibilitychange', onVisibility);
  /*
   * Pointer enter/leave over controls, delegated at the root (capture so it sees every target) —
   * but only where a hover lift can actually happen (issue #419).
   *
   * The lift this follows is a CSS `:hover` response. On a device that cannot hover there is
   * none, so every one of these reads returns the same resting zero — yet `pointerover` and
   * `pointerout` still fire on a tap, and each one starts a `requestAnimationFrame` poll that
   * spends 350ms doing a `getBoundingClientRect` plus a `getComputedStyle` per frame. That is a
   * forced layout every frame for a third of a second after each tap, to follow an animation the
   * device never plays. {@link HOVER_NONE_QUERY} is the same question the `touch:` CSS variant
   * asks — and is the constant that variant is checked against — so a touchscreen laptop, which
   * hovers with its mouse, keeps the effect. Where `matchMedia` is unavailable the answer is
   * "assume it can hover": the poll idles on its own when nothing is hovered, so guessing wrong
   * that way costs nothing, while guessing the other way would silently drop the lift on a
   * desktop.
   */
  const canHover = typeof matchMedia !== 'function' || !matchMedia(HOVER_NONE_QUERY).matches;
  if (canHover) {
    root.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
    root.addEventListener('pointerout', onPointerOut, { capture: true, passive: true });
  }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(request) : null;
  observer?.observe(document.body, { childList: true, subtree: true });
  const periodic = setInterval(request, PERIODIC_REBUILD_MS);
  rebuild();

  return {
    snapshot() {
      return snap;
    },
    hoverFollow() {
      return hover;
    },
    scrollShift() {
      // Positive = the surfaces have moved *down* the screen (the scroll went up).
      shift.page = snap.scrollY - pageY;
      // Only comparable against the *same* container the map was built against: a different one
      // (or a first scroll the map predates) has no baseline here, so it waits for the rebuild.
      const sameContainer = innerId !== 0 && innerId === snap.innerId;
      shift.inner = sameContainer ? snap.innerTop - innerTop : 0;
      shift.c0 = shift.inner === 0 ? -1 : snap.innerC0;
      shift.c1 = shift.inner === 0 ? -1 : snap.innerC1;
      return shift;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = 0;
      if (hoverRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
      hoverEl = null;
      hover = null;
      innerEl = null;
      clearInterval(periodic);
      removeEventListener('scroll', onScroll, { capture: true });
      removeEventListener('resize', request);
      document.removeEventListener('visibilitychange', onVisibility);
      root.removeEventListener('pointerover', onPointerOver, { capture: true });
      root.removeEventListener('pointerout', onPointerOut, { capture: true });
      observer?.disconnect();
    },
  };
}
