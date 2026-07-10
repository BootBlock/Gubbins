import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useBoardPointerDrag } from './useBoardPointerDrag';

/**
 * Exercises the shared dashboard pointer-drag the way {@link DashboardNav}/{@link DashboardGrid}
 * use it, without their full subtrees: a harness mounts one source tile (with an inner control, to
 * prove the interactive-origin guard) and one keyed drop target, then drives raw pointer sequences.
 *
 * jsdom has no layout, so `document.elementFromPoint` is stubbed to resolve the drop target;
 * window-level pointer events are dispatched manually (jsdom lacks a real `PointerEvent`), mirroring
 * `item-drag.test.tsx`.
 */

function Harness({
  onDrop,
  boardId = 'board',
  enabled = true,
  targetBoardId,
}: {
  onDrop: (id: string, key: string) => void;
  boardId?: string;
  enabled?: boolean;
  /** Override the target's `data-drag-board` to prove cross-board hit-tests are ignored. */
  targetBoardId?: string;
}) {
  const drag = useBoardPointerDrag({ boardId, enabled, onDrop });
  const targetProps = drag.dropProps('cell-key');
  return (
    <div>
      <div {...drag.sourceProps('tile-1', 'Tile One')} data-testid="source">
        Tile One
        <button type="button" data-testid="inner-control">
          control
        </button>
      </div>
      <div
        {...targetProps}
        data-drag-board={targetBoardId ?? targetProps['data-drag-board']}
        data-testid="target"
      />
      {drag.preview}
    </div>
  );
}

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

describe('useBoardPointerDrag', () => {
  it('drops a tile onto the drop key it is released over (mouse)', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 }); // past the activation threshold
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('tile-1', 'cell-key');
  });

  it('mounts a floating preview of the dragged tile mid-drag', () => {
    render(<Harness onDrop={vi.fn()} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });

    expect(screen.getByTestId('board-drag-preview')).toHaveTextContent('Tile One');
  });

  it('does not drop when released away from any target', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(document.body); // nothing droppable under the pointer

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('ignores a drop target belonging to another board', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} targetBoardId="other-board" />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    // The target's `data-drag-board` doesn't match, so it never resolves as a drop.
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('suppresses a drag begun on an interactive control inside the tile', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(screen.getByTestId('inner-control'), 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('drops on touch only after a stationary long press', () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10, pointerType: 'touch' });
    // The long press arms the drag without any movement.
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByTestId('board-drag-preview')).toBeTruthy();

    firePointer(window, 'pointermove', { x: 40, y: 40, pointerType: 'touch' });
    firePointer(window, 'pointerup', { x: 40, y: 40, pointerType: 'touch' });

    expect(onDrop).toHaveBeenCalledWith('tile-1', 'cell-key');
  });

  it('treats a touch that moves before the long press as a scroll, not a drag', () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10, pointerType: 'touch' });
    // Finger moves past the cancel threshold before the delay → it was a scroll.
    firePointer(window, 'pointermove', { x: 10, y: 60, pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(250));

    expect(screen.queryByTestId('board-drag-preview')).toBeNull();
    firePointer(window, 'pointerup', { x: 10, y: 60, pointerType: 'touch' });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('does not start a drag when disabled', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} enabled={false} />);
    const source = screen.getByTestId('source');
    pointHitTestAt(screen.getByTestId('target'));

    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(onDrop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('board-drag-preview')).toBeNull();
  });
});
