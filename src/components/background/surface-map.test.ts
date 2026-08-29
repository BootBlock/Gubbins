/**
 * Tests for the weather layer's control-surface lookup table (issue #68). The pure map builder is
 * exercised with plain rects; {@link trackSurfaces} gets a DOM smoke test with a mocked control
 * rect (happy-dom reports zero-size rects, so real geometry is injected per element).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSurfaceMap, resolveTopRadii, trackSurfaces, COLUMN_WIDTH, NO_SURFACE } from './surface-map';

afterEach(() => {
  document.body.innerHTML = '';
  scrollPageTo(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Fake a DOMRect for an element (happy-dom has no layout engine). */
function mockRect(el: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Scroll the page and fire the event the tracker listens for, as a real scroll would. */
function scrollPageTo(y: number): void {
  const el = document.scrollingElement ?? document.documentElement;
  Object.defineProperty(el, 'scrollTop', { value: y, configurable: true });
  document.dispatchEvent(new Event('scroll', { bubbles: true }));
}

/** A square-cornered rect literal (the common case in these tests); 40px tall by default. */
function rect(left: number, top: number, right: number, bottom: number = top + 40) {
  return { left, top, right, bottom, radiusLeft: 0, radiusRight: 0 };
}

describe('buildSurfaceMap', () => {
  it('records the topmost control edge per column (whatever is under cover stays clear)', () => {
    const { tops, bots } = buildSurfaceMap([rect(0, 100, 40), rect(20, 50, 60)], 80, 600, 4);
    expect(tops.length).toBe(20);
    // Columns only the first rect covers keep its top…
    expect(tops[0]).toBe(100);
    expect(tops[4]).toBe(100);
    // …the overlap takes the higher (smaller-y) edge…
    expect(tops[5]).toBe(50);
    expect(tops[9]).toBe(50);
    // …the second rect's solo span keeps its own top…
    expect(tops[10]).toBe(50);
    expect(tops[14]).toBe(50);
    // …and uncovered columns have no surface at all.
    expect(tops[15]).toBe(NO_SURFACE);
    expect(tops[19]).toBe(NO_SURFACE);
    // The bottoms track the same winning control per column.
    expect(bots[0]).toBe(140);
    expect(bots[5]).toBe(90);
    expect(bots[14]).toBe(90);
    expect(bots[15]).toBe(NO_SURFACE);
  });

  it('ignores rects whose top edge is outside the viewport', () => {
    const { tops } = buildSurfaceMap(
      [
        rect(0, -5, 40), // scrolled off the top — no visible edge to land on
        rect(0, 700, 40), // below the fold
        rect(-60, 100, -10), // fully off-screen left
        rect(90, 100, 120), // fully off-screen right
      ],
      80,
      600,
      4,
    );
    expect(Array.from(tops).every((t) => t === NO_SURFACE)).toBe(true);
  });

  it('records no underside for a control whose bottom sits below the fold', () => {
    const { tops, bots } = buildSurfaceMap([rect(0, 100, 40, 700)], 80, 600, 4);
    expect(tops[0]).toBe(100); // the top is landable…
    expect(bots[0]).toBe(NO_SURFACE); // …but there is no visible underside to catch on
  });

  it('clamps partially off-screen rects to the viewport columns', () => {
    const { tops } = buildSurfaceMap([rect(-20, 30, 1000)], 80, 600, 4);
    expect(tops[0]).toBe(30);
    expect(tops[19]).toBe(30);
  });

  it('follows rounded top corners down their arc instead of shelving flatly across them', () => {
    // A 16px-radius card corner: the surface the map reports must drop toward the card's edge.
    const { tops } = buildSurfaceMap(
      [{ left: 0, top: 100, right: 80, bottom: 180, radiusLeft: 16, radiusRight: 16 }],
      80,
      600,
      4,
    );
    // Flat middle: exactly the rect top.
    expect(tops[10]).toBe(100);
    // Inside the left corner the edge curves down: monotonically deeper toward the rim…
    const c0 = tops[0]!; // column centre x=2 → deep on the arc
    const c1 = tops[1]!; // x=6
    const c2 = tops[2]!; // x=10
    const c3 = tops[3]!; // x=14
    expect(c0).toBeGreaterThan(c1);
    expect(c1).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c3);
    expect(c3).toBeGreaterThanOrEqual(100);
    // …with the outermost column well below the flat top (quarter-circle: 16 − √(16² − 14²) ≈ 8).
    expect(c0 - 100).toBeGreaterThanOrEqual(7);
    // The right corner mirrors it.
    expect(tops[19]).toBe(c0);
    expect(tops[18]).toBe(c1);
  });
});

describe('resolveTopRadii', () => {
  it("resolves a pill's oversized radii to the drawn height/2, per CSS overflow scaling", () => {
    // rounded-full: all four corners huge; on an 80×26 chip the drawn radius is 13, not 26.
    const [left, right] = resolveTopRadii(9999, 9999, 9999, 9999, 80, 26);
    expect(left).toBeCloseTo(13);
    expect(right).toBeCloseTo(13);
  });

  it('keeps a single large corner at full size when no side overflows', () => {
    // One 100px top-left corner on a 120×200 box: CSS scales nothing down.
    const [left, right] = resolveTopRadii(100, 0, 0, 0, 120, 200);
    expect(left).toBe(100);
    expect(right).toBe(0);
  });

  it('scales uniform radii down by the worst side (vertical here), like the browser does', () => {
    // rounded-2xl (16) on an 80×24 element: the 24px sides carry 16+16 → factor 24/32 = 0.75.
    const [left, right] = resolveTopRadii(16, 16, 16, 16, 80, 24);
    expect(left).toBeCloseTo(12);
    expect(right).toBeCloseTo(12);
  });

  it('returns square corners when the top radii are zero', () => {
    expect(resolveTopRadii(0, 0, 20, 20, 80, 24)).toEqual([0, 0]);
  });
});

describe('trackSurfaces', () => {
  it('builds the map from on-screen controls and detaches cleanly', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    mockRect(btn, 10, 40, 80, 30);
    // Too small to land on — filtered out.
    const tiny = document.createElement('button');
    document.body.appendChild(tiny);
    mockRect(tiny, 200, 40, 10, 8);
    // Inside an excluded layer (dialog content floats above the overlay) — ignored.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogBtn = document.createElement('button');
    dialog.appendChild(dialogBtn);
    document.body.appendChild(dialog);
    mockRect(dialogBtn, 300, 40, 80, 30);
    // A resting card surface counts…
    const card = document.createElement('div');
    card.className = 'rounded-2xl bg-card/80 shadow';
    document.body.appendChild(card);
    mockRect(card, 400, 60, 120, 80);
    // …but a hover-only card tint does not: the element is transparent at rest, so snow
    // settling along its invisible top edge would float mid-list.
    const hoverRow = document.createElement('div');
    hoverRow.className = 'hover:bg-card/60';
    document.body.appendChild(hoverRow);
    mockRect(hoverRow, 600, 60, 120, 40);

    const tracker = trackSurfaces();
    const snap = tracker.snapshot();
    expect(snap.tops.length).toBe(Math.ceil(innerWidth / COLUMN_WIDTH));
    expect(snap.tops[Math.floor(10 / COLUMN_WIDTH)]).toBe(40);
    expect(snap.tops[Math.floor(89 / COLUMN_WIDTH)]).toBe(40);
    expect(snap.bots[Math.floor(10 / COLUMN_WIDTH)]).toBe(70); // the same control's underside
    expect(snap.tops[Math.floor(200 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    expect(snap.tops[Math.floor(300 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    expect(snap.tops[Math.floor(450 / COLUMN_WIDTH)]).toBe(60);
    expect(snap.tops[Math.floor(650 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    // Nothing is hovered, so there is no follow offset.
    expect(tracker.hoverFollow()).toBeNull();
    expect(() => {
      tracker.stop();
      tracker.stop();
    }).not.toThrow();
  });

  it('reports how far the page has scrolled since the map was built (issue #438)', () => {
    vi.useFakeTimers();
    // The rebuild is scheduled inside a rAF; run it inline so advancing the timers is enough.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    mockRect(btn, 10, 400, 80, 30);

    const tracker = trackSurfaces();
    const col = Math.floor(10 / COLUMN_WIDTH);
    const built = tracker.snapshot().generation;
    expect(tracker.scrollShift()).toBe(0);

    // The page scrolls 120px down. The rebuild is still debounced, so the map keeps describing
    // where the control *was* — and the shift is what says where it is now (negative = moved up).
    scrollPageTo(120);
    expect(tracker.snapshot().generation).toBe(built);
    expect(tracker.snapshot().tops[col]).toBe(400);
    expect(tracker.scrollShift()).toBe(-120);

    // The debounce expires and the map is rebuilt at the new position: the shift is spent, and
    // the snapshot publishes the scroll offset it was built at.
    mockRect(btn, 10, 280, 80, 30);
    vi.advanceTimersByTime(200);
    expect(tracker.snapshot().generation).toBeGreaterThan(built);
    expect(tracker.snapshot().tops[col]).toBe(280);
    expect(tracker.snapshot().scrollY).toBe(120);
    expect(tracker.scrollShift()).toBe(0);

    tracker.stop();
    vi.useRealTimers();
  });

  it('counts a scroll as a change even when the map itself is identical (issue #438)', () => {
    // No landable control at all, so the maps before and after are byte-identical. The published
    // scroll offset must still move, or a consumer would keep drawing at a spent shift.
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const tracker = trackSurfaces();
    const built = tracker.snapshot().generation;
    scrollPageTo(60);
    vi.advanceTimersByTime(200);
    expect(tracker.snapshot().generation).toBeGreaterThan(built);
    expect(tracker.snapshot().scrollY).toBe(60);
    expect(tracker.scrollShift()).toBe(0);
    tracker.stop();
    vi.useRealTimers();
  });
});
