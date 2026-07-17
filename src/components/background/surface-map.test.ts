/**
 * Tests for the weather layer's control-surface lookup table (issue #68). The pure map builder is
 * exercised with plain rects; {@link trackSurfaces} gets a DOM smoke test with a mocked control
 * rect (happy-dom reports zero-size rects, so real geometry is injected per element).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildSurfaceMap, trackSurfaces, COLUMN_WIDTH, NO_SURFACE } from './surface-map';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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

describe('buildSurfaceMap', () => {
  it('records the topmost control edge per column (whatever is under cover stays clear)', () => {
    const tops = buildSurfaceMap(
      [
        { left: 0, top: 100, right: 40 },
        { left: 20, top: 50, right: 60 },
      ],
      80,
      600,
      4,
    );
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
  });

  it('ignores rects whose top edge is outside the viewport', () => {
    const tops = buildSurfaceMap(
      [
        { left: 0, top: -5, right: 40 }, // scrolled off the top — no visible edge to land on
        { left: 0, top: 700, right: 40 }, // below the fold
        { left: -60, top: 100, right: -10 }, // fully off-screen left
        { left: 90, top: 100, right: 120 }, // fully off-screen right
      ],
      80,
      600,
      4,
    );
    expect(Array.from(tops).every((t) => t === NO_SURFACE)).toBe(true);
  });

  it('clamps partially off-screen rects to the viewport columns', () => {
    const tops = buildSurfaceMap([{ left: -20, top: 30, right: 1000 }], 80, 600, 4);
    expect(tops[0]).toBe(30);
    expect(tops[19]).toBe(30);
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
    expect(snap.tops[Math.floor(200 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    expect(snap.tops[Math.floor(300 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    expect(snap.tops[Math.floor(450 / COLUMN_WIDTH)]).toBe(60);
    expect(snap.tops[Math.floor(650 / COLUMN_WIDTH)]).toBe(NO_SURFACE);
    expect(() => {
      tracker.stop();
      tracker.stop();
    }).not.toThrow();
  });
});
