import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ItemDragProvider, useItemDragSource, useLocationDragSource, useLocationRowDrop } from './item-drag';

/**
 * Exercises the unified pointer-drag machinery the way {@link ItemCard}/{@link ItemRow} (drag
 * sources) and {@link LocationTreeItem} (drop targets) use it, without pulling in their full
 * subtrees. A tiny harness mounts one source (containing an inner control, to prove the
 * interactive-origin guard) and one drop target wired exactly like the sidebar
 * (`onDrop → move({ id, locationId })`), then drives raw pointer sequences.
 *
 * jsdom has no layout, so `document.elementFromPoint` is stubbed to resolve the drop target;
 * window-level pointer events are dispatched manually so `clientX/clientY/pointerType/pointerId`
 * are always present (jsdom lacks a real `PointerEvent`).
 */

const ITEM = { id: 'item-1', name: 'NE555 timer' };
const LOCATION_ID = 'loc-workshop';

function Harness({ onDrop }: { onDrop: (payload: { id: string; locationId: string }) => void }) {
  return (
    <ItemDragProvider>
      <Source />
      <Target onDrop={onDrop} />
    </ItemDragProvider>
  );
}

function Source() {
  const drag = useItemDragSource(ITEM);
  return (
    <div {...drag} data-testid="source">
      {ITEM.name}
      <button type="button" data-testid="inner-control">
        control
      </button>
    </div>
  );
}

function Target({ onDrop }: { onDrop: (payload: { id: string; locationId: string }) => void }) {
  // Mirrors LocationSidebar's per-node wiring: the drop hands back the item id, the row folds
  // in its own location id.
  const active = useLocationRowDrop(LOCATION_ID, {
    onDropItem: (itemId) => onDrop({ id: itemId, locationId: LOCATION_ID }),
  });
  return (
    <div data-tree-id={LOCATION_ID} data-testid="target" data-active={active ? 'true' : 'false'}>
      Workshop
    </div>
  );
}

/** Dispatch a fully-populated pointer event (jsdom's PointerEvent is absent/partial). */
function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { x?: number; y?: number; pointerType?: string; pointerId?: number; button?: number } = {},
) {
  const { x = 0, y = 0, pointerType = 'mouse', pointerId = 1, button = 0 } = init;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerType, pointerId, button });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Point every hit-test at the given element until restored. */
function pointHitTestAt(el: Element | null) {
  document.elementFromPoint = vi.fn(() => el);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('item-drag — unified pointer drag-to-move', () => {
  it('moves an item when a mouse drag is released over a location row', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 }); // past the activation threshold
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ id: 'item-1', locationId: 'loc-workshop' });
  });

  it('passes the dropped item id and name to onDropItem (so the mover can name it in feedback)', () => {
    const onDropItem = vi.fn();
    function NamedTarget() {
      const active = useLocationRowDrop(LOCATION_ID, { onDropItem });
      return (
        <div data-tree-id={LOCATION_ID} data-testid="target" data-active={active ? 'true' : 'false'}>
          Workshop
        </div>
      );
    }
    render(
      <ItemDragProvider>
        <Source />
        <NamedTarget />
      </ItemDragProvider>,
    );
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDropItem).toHaveBeenCalledWith('item-1', 'NE555 timer');
  });

  it('highlights the row under the pointer and mounts a floating preview mid-drag', () => {
    render(<Harness onDrop={vi.fn()} />);
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(target.getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('item-drag-preview')).toHaveTextContent('NE555 timer');

    // Leaving the row clears the highlight.
    pointHitTestAt(document.body);
    firePointer(window, 'pointermove', { x: 300, y: 300 });
    expect(target.getAttribute('data-active')).toBe('false');
  });

  it('does not move when the drag is released away from any location row', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(document.body); // nothing droppable under the pointer

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('suppresses a drag begun on an interactive control inside the source', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const control = screen.getByTestId('inner-control');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(control, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('moves on touch only after a stationary long press', () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10, pointerType: 'touch' });
    // The long press arms the drag without any movement.
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByTestId('item-drag-preview')).toBeTruthy();

    firePointer(window, 'pointermove', { x: 40, y: 40, pointerType: 'touch' });
    firePointer(window, 'pointerup', { x: 40, y: 40, pointerType: 'touch' });

    expect(onDrop).toHaveBeenCalledWith({ id: 'item-1', locationId: 'loc-workshop' });
  });

  it('rejects a move onto the location the item is already in, showing the forbidden cursor', () => {
    const onDrop = vi.fn();
    // An item whose current location IS the drop target — moving it there is a no-op.
    function SameLocationSource() {
      const drag = useItemDragSource({ id: 'item-1', name: 'NE555 timer', locationId: LOCATION_ID });
      return (
        <div {...drag} data-testid="source">
          NE555 timer
        </div>
      );
    }
    render(
      <ItemDragProvider>
        <SameLocationSource />
        <Target onDrop={onDrop} />
      </ItemDragProvider>,
    );
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    // The row rejects it: no highlight, and <body> carries the forbidden-cursor class.
    expect(target.getAttribute('data-active')).toBe('false');
    expect(document.body.classList.contains('gubbins-dragging')).toBe(true);
    expect(document.body.classList.contains('gubbins-drag-invalid')).toBe(true);

    firePointer(window, 'pointerup', { x: 40, y: 40 });
    expect(onDrop).not.toHaveBeenCalled();
    // Both classes are cleared once the gesture ends.
    expect(document.body.classList.contains('gubbins-dragging')).toBe(false);
    expect(document.body.classList.contains('gubbins-drag-invalid')).toBe(false);
  });

  it('shows the grabbing cursor (not the forbidden one) over a valid target', () => {
    render(<Harness onDrop={vi.fn()} />);
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(target.getAttribute('data-active')).toBe('true');
    expect(document.body.classList.contains('gubbins-dragging')).toBe(true);
    expect(document.body.classList.contains('gubbins-drag-invalid')).toBe(false);
  });

  it('shows the forbidden cursor over a tree row that is not a drop target (e.g. "All items")', () => {
    const onDrop = vi.fn();
    render(
      <ItemDragProvider>
        <Source />
        {/* A tree row carrying a data-tree-id but never wired as a drop target — exactly like the
            synthetic "All items" filter row, which an item can't be moved *to*. */}
        <div data-tree-id="all-items" data-testid="all-items">
          All items
        </div>
      </ItemDragProvider>,
    );
    const source = screen.getByTestId('source');
    const allItems = screen.getByTestId('all-items');
    pointHitTestAt(allItems);

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    // Over a non-droppable tree row the cursor is forbidden (not the plain grabbing of empty space).
    expect(document.body.classList.contains('gubbins-dragging')).toBe(true);
    expect(document.body.classList.contains('gubbins-drag-invalid')).toBe(true);

    firePointer(window, 'pointerup', { x: 40, y: 40 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('treats a touch that moves before the long press as a scroll, not a drag', () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    const target = screen.getByTestId('target');
    pointHitTestAt(target);

    firePointer(source, 'pointerdown', { x: 10, y: 10, pointerType: 'touch' });
    // Finger moves past the cancel threshold before the press delay → it was a scroll.
    firePointer(window, 'pointermove', { x: 10, y: 60, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(250));

    // No preview ever mounts, and a later release drops nothing.
    expect(screen.queryByTestId('item-drag-preview')).toBeNull();
    firePointer(window, 'pointerup', { x: 10, y: 60, pointerType: 'touch' });
    expect(onDrop).not.toHaveBeenCalled();
  });
});

/**
 * A location row is both a drag *source* (spread `useLocationDragSource`) and a drop *target*
 * (`useLocationRowDrop`), so dragging one location onto another nests it. `acceptsLocation`
 * vetoes an illegal nest (self / a descendant), which the provider honours by neither
 * highlighting nor dropping.
 */
function LocationRow({
  id,
  name,
  onDropLocation,
  acceptsLocation,
}: {
  id: string;
  name: string;
  onDropLocation?: (draggedId: string) => void;
  acceptsLocation?: (draggedId: string) => boolean;
}) {
  const drag = useLocationDragSource({ id, name });
  const active = useLocationRowDrop(id, { onDropLocation, acceptsLocation });
  return (
    <div {...drag} data-tree-id={id} data-testid={`loc-${id}`} data-active={active ? 'true' : 'false'}>
      {name}
    </div>
  );
}

describe('item-drag — location drag-to-nest', () => {
  it('nests a location when dropped onto another location row', () => {
    const onDropLocation = vi.fn();
    render(
      <ItemDragProvider>
        <LocationRow id="child" name="Cabinet" />
        <LocationRow id="parent" name="Workshop" onDropLocation={onDropLocation} />
      </ItemDragProvider>,
    );
    const child = screen.getByTestId('loc-child');
    const parent = screen.getByTestId('loc-parent');
    pointHitTestAt(parent);

    firePointer(child, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    // The preview shows the dragged location's name, and the parent lights up as the target.
    expect(screen.getByTestId('item-drag-preview')).toHaveTextContent('Cabinet');
    expect(parent.getAttribute('data-active')).toBe('true');

    firePointer(window, 'pointerup', { x: 40, y: 40 });
    expect(onDropLocation).toHaveBeenCalledWith('child');
  });

  it('refuses to nest a location under a descendant (no highlight, no drop)', () => {
    const onDropLocation = vi.fn();
    render(
      <ItemDragProvider>
        <LocationRow id="ancestor" name="Workshop" />
        {/* A descendant of "ancestor" rejects it as a parent — the cycle guard. */}
        <LocationRow
          id="descendant"
          name="Drawer"
          onDropLocation={onDropLocation}
          acceptsLocation={(draggedId) => draggedId !== 'ancestor'}
        />
      </ItemDragProvider>,
    );
    const ancestor = screen.getByTestId('loc-ancestor');
    const descendant = screen.getByTestId('loc-descendant');
    pointHitTestAt(descendant);

    firePointer(ancestor, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    // The vetoed target never highlights…
    expect(descendant.getAttribute('data-active')).toBe('false');

    firePointer(window, 'pointerup', { x: 40, y: 40 });
    // …and releasing over it drops nothing.
    expect(onDropLocation).not.toHaveBeenCalled();
  });
});
