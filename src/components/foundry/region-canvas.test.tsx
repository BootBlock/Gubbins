import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RegionCanvas, type RegionCanvasRegion } from './region-canvas';
import { serialiseGeometry } from '@/features/inventory/regions/geometry';

afterEach(cleanup);

/**
 * jsdom lays nothing out — every `getBoundingClientRect` is zeros, which `containBox` correctly
 * reports as "not measurable" and the component treats as "no gesture". Stubbing one honest
 * rectangle is what makes the pointer path testable at all; the maths behind it is already
 * covered directly in `features/inventory/regions`.
 *
 * The photo is 400×300 and the box is 400×300, so the content box is 1:1 and a client pixel is a
 * display pixel — the arithmetic in each test stays readable.
 */
const BOX = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(BOX as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SHELF: RegionCanvasRegion = {
  id: 'r1',
  name: 'Top shelf',
  shape: 'rect',
  geometry: serialiseGeometry({ shape: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
  color: null,
  position: 0,
};

const BIN: RegionCanvasRegion = {
  id: 'r2',
  name: 'Parts bin',
  shape: 'circle',
  geometry: serialiseGeometry({ shape: 'circle', cx: 0.7, cy: 0.7, r: 0.1 }),
  color: 'teal',
  position: 1,
};

function renderCanvas(props: Partial<React.ComponentProps<typeof RegionCanvas>> = {}) {
  return render(
    <RegionCanvas
      src="blob:photo"
      alt="Workshop shelving"
      naturalWidth={400}
      naturalHeight={300}
      regions={[SHELF, BIN]}
      {...props}
    />,
  );
}

describe('RegionCanvas — rendering', () => {
  it('renders the photo as a content image, contained rather than cropped', () => {
    renderCanvas();
    const img = screen.getByAltText('Workshop shelving');
    expect(img).toHaveAttribute('src', 'blob:photo');
    // The whole photo must be visible to draw on — `object-cover` would hide part of it.
    expect(img.className).toContain('object-contain');
    expect(img.className).not.toContain('object-cover');
  });

  it('renders each region as a named button, so every shape is reachable without a pointer', () => {
    renderCanvas();
    expect(screen.getByRole('button', { name: 'Top shelf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Parts bin' })).toBeInTheDocument();
  });

  it('takes accessible names from the label prop, so a call site can pass translated copy', () => {
    renderCanvas({ regionLabel: (region) => `${region.name}, 3 Artikel`, overlayLabel: 'Fotobereiche' });
    expect(screen.getByRole('button', { name: 'Top shelf, 3 Artikel' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Fotobereiche' })).toBeInTheDocument();
  });

  it('drops an unparseable region instead of taking the whole overlay down', () => {
    renderCanvas({ regions: [SHELF, { ...BIN, geometry: 'not json' }] });
    expect(screen.getByRole('button', { name: 'Top shelf' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Parts bin' })).not.toBeInTheDocument();
  });

  it('tints a region with its location swatch, and uses the shape tokens when it has none', () => {
    renderCanvas();
    // Colour comes from the `--loc-*` / `--shape-*` token families — never a raw literal.
    expect(screen.getByRole('button', { name: 'Parts bin' }).innerHTML).toContain('stroke-loc-teal');
    expect(screen.getByRole('button', { name: 'Top shelf' }).innerHTML).toContain('stroke-shape-stroke');
  });

  it('marks the selected region as pressed', () => {
    renderCanvas({ selectedId: 'r1' });
    expect(screen.getByRole('button', { name: 'Top shelf' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Parts bin' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('RegionCanvas — read-only is the default', () => {
  it('renders no resize handles and claims no touch gestures', () => {
    renderCanvas({ selectedId: 'r1' });
    expect(screen.queryByRole('button', { name: /Resize region/ })).not.toBeInTheDocument();
    // A viewer embedded in a scrolling dialog must still be scrollable past.
    expect(screen.getByTestId('region-canvas-surface')).not.toHaveStyle({ touchAction: 'none' });
  });

  it('still supports selection — a viewer can point at a region without being able to edit it', () => {
    const onSelect = vi.fn();
    renderCanvas({ onSelect });
    fireEvent.click(screen.getByRole('button', { name: 'Parts bin' }));
    expect(onSelect).toHaveBeenCalledWith('r2');
  });

  it('never commits geometry from the keyboard', () => {
    const onCommit = vi.fn();
    renderCanvas({ selectedId: 'r1', onCommit });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Top shelf' }), { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('never starts a drawing gesture', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, tool: 'rect' });
    const surface = screen.getByTestId('region-canvas-surface');
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 190, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 240, clientY: 190, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('region-canvas-draft')).not.toBeInTheDocument();
  });
});

describe('RegionCanvas — keyboard editing', () => {
  it('activates a region on Enter and Space', () => {
    const onSelect = vi.fn();
    renderCanvas({ onSelect, readOnly: false });
    const shelf = screen.getByRole('button', { name: 'Top shelf' });
    fireEvent.keyDown(shelf, { key: 'Enter' });
    fireEvent.keyDown(shelf, { key: ' ' });
    expect(onSelect).toHaveBeenNthCalledWith(1, 'r1');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'r1');
  });

  it('clears the selection on Escape', () => {
    const onSelect = vi.fn();
    renderCanvas({ onSelect, readOnly: false, selectedId: 'r1' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Top shelf' }), { key: 'Escape' });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('nudges the selected region with an arrow key', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, selectedId: 'r1' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Top shelf' }), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const moved = onCommit.mock.calls[0]![0];
    expect(moved).toMatchObject({ shape: 'rect', w: 0.3, h: 0.3 });
    expect(moved.x).toBeGreaterThan(0.1); // moved, not resized
  });

  it('resizes the selected region with Shift+arrow', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, selectedId: 'r1' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Top shelf' }), {
      key: 'ArrowRight',
      shiftKey: true,
    });
    const resized = onCommit.mock.calls[0]![0];
    expect(resized.x).toBeCloseTo(0.1); // anchored at the top-left, as dragging the `se` handle is
    expect(resized.w).toBeGreaterThan(0.3);
  });

  it('leaves an unselected region alone — arrows only move what is selected', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, selectedId: 'r1' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Parts bin' }), { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not swallow Tab, so focus can always leave the canvas', () => {
    renderCanvas({ readOnly: false, selectedId: 'r1' });
    const shelf = screen.getByRole('button', { name: 'Top shelf' });
    // `fireEvent.keyDown` returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(shelf, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(shelf, { key: 'ArrowRight' })).toBe(false);
  });
});

describe('RegionCanvas — pointer drawing', () => {
  it('claims the whole touch gesture while editing', () => {
    renderCanvas({ readOnly: false });
    expect(screen.getByTestId('region-canvas-surface')).toHaveStyle({ touchAction: 'none' });
  });

  it('draws a new rectangle, previewing it live and committing it on release', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, tool: 'rect', regions: [] });
    const surface = screen.getByTestId('region-canvas-surface');

    fireEvent.pointerDown(surface, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 180, pointerId: 1 });
    // Past the arming distance, so the drag is live and the draft is on screen.
    expect(screen.getByTestId('region-canvas-draft')).toBeInTheDocument();

    fireEvent.pointerUp(window, { clientX: 240, clientY: 180, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toMatchObject({
      shape: 'rect',
      x: expect.closeTo(0.1, 6),
      y: expect.closeTo(0.1, 6),
      w: expect.closeTo(0.5, 6),
      h: expect.closeTo(0.5, 6),
    });
    // The preview is feedback, not a region — it goes away once the real one exists.
    expect(screen.queryByTestId('region-canvas-draft')).not.toBeInTheDocument();
  });

  it('discards a stray click rather than creating an invisible region', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, tool: 'rect', regions: [] });
    const surface = screen.getByTestId('region-canvas-surface');
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 41, clientY: 31, pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('abandons the gesture on pointercancel, leaving nothing behind', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, tool: 'rect', regions: [] });
    const surface = screen.getByTestId('region-canvas-surface');
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 240, clientY: 180, pointerId: 1 });
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('region-canvas-draft')).not.toBeInTheDocument();
  });

  it('selects the topmost region a press lands in, resolving overlaps by z-order', () => {
    const onSelect = vi.fn();
    // Two regions covering the same ground; the higher `position` is the one drawn on top.
    const under: RegionCanvasRegion = { ...SHELF, id: 'under', name: 'Under', position: 0 };
    const over: RegionCanvasRegion = { ...SHELF, id: 'over', name: 'Over', position: 5 };
    renderCanvas({ onSelect, readOnly: false, regions: [under, over] });
    // (80, 60) is normalised (0.2, 0.2) — inside both.
    fireEvent.pointerDown(screen.getByTestId('region-canvas-surface'), {
      clientX: 80,
      clientY: 60,
      pointerId: 1,
    });
    expect(onSelect).toHaveBeenCalledWith('over');
  });

  it('clears the selection when the press lands on bare photo', () => {
    const onSelect = vi.fn();
    renderCanvas({ onSelect, readOnly: false });
    fireEvent.pointerDown(screen.getByTestId('region-canvas-surface'), {
      clientX: 380,
      clientY: 20,
      pointerId: 1,
    });
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('moves the selected region when the press starts on its body', () => {
    const onCommit = vi.fn();
    renderCanvas({ onCommit, readOnly: false, selectedId: 'r1', regions: [SHELF] });
    const surface = screen.getByTestId('region-canvas-surface');
    // Start inside the rect (0.1–0.4 of a 400×300 photo) and drag right.
    fireEvent.pointerDown(surface, { clientX: 80, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 60, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toMatchObject({
      shape: 'rect',
      x: expect.closeTo(0.3, 6), // +80px of a 400px photo
      w: 0.3, // size preserved — moved, not resized
    });
  });
});

describe('RegionCanvas — resize handles', () => {
  it('offers one handle per rectangle corner and edge while editing', () => {
    renderCanvas({ readOnly: false, selectedId: 'r1', regions: [SHELF] });
    expect(screen.getAllByRole('button', { name: /Resize region/ })).toHaveLength(8);
  });

  it('offers a single radius handle for a circle — its one degree of freedom', () => {
    renderCanvas({ readOnly: false, selectedId: 'r2', regions: [BIN] });
    const handles = screen.getAllByRole('button', { name: /Resize region/ });
    expect(handles).toHaveLength(1);
    expect(handles[0]).toHaveAttribute('data-handle', 'radius');
  });

  it('offers one handle per polygon vertex', () => {
    const bench: RegionCanvasRegion = {
      id: 'r3',
      name: 'Bench',
      shape: 'polygon',
      geometry: serialiseGeometry({
        shape: 'polygon',
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.6, y: 0.2 },
          { x: 0.4, y: 0.6 },
        ],
      }),
      color: null,
      position: 0,
    };
    renderCanvas({ readOnly: false, selectedId: 'r3', regions: [bench] });
    expect(screen.getAllByRole('button', { name: /Resize region/ })).toHaveLength(3);
  });

  it('names its handles from the prop, so the copy can be translated', () => {
    renderCanvas({
      readOnly: false,
      selectedId: 'r2',
      regions: [BIN],
      handleLabel: () => 'Größe ändern',
    });
    expect(screen.getByRole('button', { name: 'Größe ändern' })).toBeInTheDocument();
  });
});
