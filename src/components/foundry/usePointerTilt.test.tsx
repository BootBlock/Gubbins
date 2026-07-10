import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePointerTilt } from './usePointerTilt';
import type { MediaQueryLike, MediaQueryProvider } from './useReducedMotion';
import { PREFERS_REDUCED_MOTION_QUERY } from '@/lib/env/motion';
import { FINE_POINTER_QUERY } from './pointer-tilt';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** A minimal static MediaQueryList fake (the hook re-reads via matchMedia; no live flip needed). */
class FakeMedia implements MediaQueryLike {
  constructor(public matches: boolean) {}
  addEventListener() {}
  removeEventListener() {}
}

/**
 * Build a provider that answers each media query independently, so a single fake can model any
 * combination of "prefers reduced motion" and "has a fine pointer".
 */
function provide({ reduced, fine }: { reduced: boolean; fine: boolean }): MediaQueryProvider {
  return vi.fn((query: string) => {
    if (query === PREFERS_REDUCED_MOTION_QUERY) return new FakeMedia(reduced);
    if (query === FINE_POINTER_QUERY) return new FakeMedia(fine);
    return new FakeMedia(false);
  });
}

/** A React-PointerEvent-shaped stub carrying only the fields the handlers read. */
function pointerEvent(
  target: HTMLElement,
  x: number,
  y: number,
  extra: { pointerType?: string; buttons?: number } = {},
) {
  const { pointerType = 'mouse', buttons = 0 } = extra;
  return {
    currentTarget: target,
    clientX: x,
    clientY: y,
    pointerType,
    buttons,
  } as unknown as React.PointerEvent<HTMLElement>;
}

/** A card element with a fixed 200×100 box so the resolved tilt values are exact. */
function fakeCard(): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  return el;
}

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ reduceEffects: false });
});

describe('usePointerTilt — gate fall-through', () => {
  it('attaches no handlers under reduced motion (belt-and-braces with the CSS)', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: true, fine: true }) }),
    );
    expect(result.current.onPointerMove).toBeUndefined();
    expect(result.current.onPointerLeave).toBeUndefined();
  });

  it('attaches no handlers when "Reduce effects" (F9) is on, even on a fine pointer with OS motion allowed', () => {
    usePreferencesStore.setState({ reduceEffects: true });
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    // The F9 pref OR's into the decoration-motion gate, so tilt is off without OS reduced-motion.
    expect(result.current.onPointerMove).toBeUndefined();
    expect(result.current.onPointerLeave).toBeUndefined();
  });

  it('attaches no handlers on a coarse (touch) pointer — tilt is a hover affordance', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: false }) }),
    );
    expect(result.current.onPointerMove).toBeUndefined();
    expect(result.current.onPointerLeave).toBeUndefined();
  });

  it('returns handlers only when motion is permitted AND the pointer is fine', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    expect(typeof result.current.onPointerMove).toBe('function');
    expect(typeof result.current.onPointerLeave).toBe('function');
  });
});

describe('usePointerTilt — CSS-var writes (enabled)', () => {
  beforeEach(() => {
    // Run the rAF flush synchronously so the assertion doesn't race the frame.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('writes the resolved tilt/parallax/glare vars on pointer-move', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    const card = fakeCard();
    // Pointer at the top-left corner of the 200×100 box → the peak lean toward that corner.
    act(() => result.current.onPointerMove!(pointerEvent(card, 0, 0)));
    expect(card.style.getPropertyValue('--tilt-rx')).toBe('6deg');
    expect(card.style.getPropertyValue('--tilt-ry')).toBe('-6deg');
    expect(card.style.getPropertyValue('--tilt-px')).toBe('10px');
    expect(card.style.getPropertyValue('--tilt-py')).toBe('10px');
    expect(card.style.getPropertyValue('--tilt-gx')).toBe('0%');
    expect(card.style.getPropertyValue('--tilt-gy')).toBe('0%');
  });

  it('ignores a touch pointer even when attached (hybrid fine+coarse device)', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    const card = fakeCard();
    act(() => result.current.onPointerMove!(pointerEvent(card, 0, 0, { pointerType: 'touch' })));
    // No var written — tilt is a hover affordance, never fired by a finger.
    expect(card.style.getPropertyValue('--tilt-rx')).toBe('');
  });

  it('ignores a move while a button is held (a press-drag, not a hover)', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    const card = fakeCard();
    act(() => result.current.onPointerMove!(pointerEvent(card, 0, 0, { buttons: 1 })));
    expect(card.style.getPropertyValue('--tilt-rx')).toBe('');
  });

  it('resets to the flat rest state on pointer-leave', () => {
    const { result } = renderHook(() =>
      usePointerTilt({ mediaProvider: provide({ reduced: false, fine: true }) }),
    );
    const card = fakeCard();
    act(() => result.current.onPointerMove!(pointerEvent(card, 0, 0)));
    expect(card.style.getPropertyValue('--tilt-rx')).toBe('6deg');
    act(() => result.current.onPointerLeave!(pointerEvent(card, 0, 0)));
    expect(card.style.getPropertyValue('--tilt-rx')).toBe('0deg');
    expect(card.style.getPropertyValue('--tilt-ry')).toBe('0deg');
    expect(card.style.getPropertyValue('--tilt-px')).toBe('0px');
    expect(card.style.getPropertyValue('--tilt-gx')).toBe('50%');
  });
});
