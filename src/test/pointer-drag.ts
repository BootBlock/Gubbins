/**
 * Drives the app's pointer drags from a test: `item-drag` (items and locations) and
 * `useBoardPointerDrag` (dashboard tiles). Both follow a drag through pointer events on `window`
 * and find the drop target with `document.elementFromPoint`.
 *
 * happy-dom provides both, but lays nothing out. Its `PointerEvent` is a real one carrying every
 * field a drag reads, so a test dispatches that. Its `elementFromPoint` answers `null` for every
 * point, so a test names the drop target with {@link pointHitTestAt}.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

/** The pointer events a drag listens for. */
export type DragPointerEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

/** Where a pointer event lands and what fires it. The defaults are a mouse's primary button at 0,0. */
export interface PointerInit {
  x?: number;
  y?: number;
  pointerType?: string;
  pointerId?: number;
  button?: number;
}

/** Dispatch a bubbling, cancelable `PointerEvent` at `target`, inside `act`. */
export function firePointer(target: EventTarget, type: DragPointerEventType, init: PointerInit = {}): void {
  const { x = 0, y = 0, pointerType = 'mouse', pointerId = 1, button = 0 } = init;
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerType,
    pointerId,
    button,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Dispatch a cancelable `touchmove` on window and return it, so a test can read `defaultPrevented`. */
export function fireTouchMove(): Event {
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/**
 * Point every hit-test at `el` until `vi.restoreAllMocks()`. A spy rather than an assignment, so
 * restoring it removes it and leaves happy-dom's own `elementFromPoint` in place.
 */
export function pointHitTestAt(el: Element | null): void {
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(el);
}
