import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ItemDragProvider, useItemDragSource, useItemDropTarget } from './item-drag';

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
  const active = useItemDropTarget(LOCATION_ID, (itemId) => onDrop({ id: itemId, locationId: LOCATION_ID }));
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
