/**
 * Tests for `useInViewport` — the visibility gate the Reports screen hangs its below-the-fold
 * queries off (issue #528). The IntersectionObserver is injected, so the whole contract is
 * exercised without a real browser: idle until seen, live while on screen, idle again once
 * scrolled past, and permanently open where no observer exists.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import {
  useInViewport,
  DEFAULT_VIEWPORT_MARGIN,
  type IntersectionObserverFactory,
  type ObserverLike,
  type InViewportOptions,
} from './index';

afterEach(cleanup);

/** A controllable fake IntersectionObserver that records wiring and can fire on demand. */
class FakeObserver implements ObserverLike {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {}
  /** Simulate the element (not) intersecting the viewport. */
  fire(...samples: boolean[]) {
    this.cb(
      samples.map((isIntersecting) => ({ isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

/** A factory that captures every observer it builds so a test can drive them. */
function makeFactory() {
  const observers: FakeObserver[] = [];
  const factory: IntersectionObserverFactory = (cb, options) => {
    const o = new FakeObserver(cb, options);
    observers.push(o);
    return o;
  };
  return { factory, observers };
}

/**
 * A probe that drives the hook with the ref attached to a *real* DOM node — the realistic path,
 * where React sets the callback ref during commit so the effect below it finds an element to
 * observe. The reported flag is rendered so a test can read it back out of the DOM.
 */
function Probe(options: InViewportOptions) {
  const { ref, inView } = useInViewport(options);
  return (
    <div ref={ref} data-testid="probe">
      {String(inView)}
    </div>
  );
}

function reported(): string {
  return screen.getByTestId('probe').textContent ?? '';
}

describe('useInViewport', () => {
  it('starts closed and opens on the first intersection', () => {
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} />);

    // Nothing has been reported yet, so the caller's work stays idle.
    expect(reported()).toBe('false');
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledTimes(1);

    act(() => observers[0]!.fire(true));
    expect(reported()).toBe('true');
  });

  it('closes again when the element scrolls back out of view', () => {
    // This is the half that separates the gate from the one-shot reveal: an off-screen panel
    // must go idle again, or a write would keep re-running its report for the rest of the
    // session (issue #528).
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} />);

    act(() => observers[0]!.fire(true));
    expect(reported()).toBe('true');

    act(() => observers[0]!.fire(false));
    expect(reported()).toBe('false');
  });

  it('takes the latest sample when a delivery carries several', () => {
    // A batched delivery can hold more than one sample for the same element; the answer is the
    // last one, not whether any of them intersected.
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} />);

    act(() => observers[0]!.fire(true, false));
    expect(reported()).toBe('false');

    act(() => observers[0]!.fire(false, true));
    expect(reported()).toBe('true');
  });

  it('reports open from the first render when there is no observer', () => {
    // Enhance-downward: without an observer the caller must do all of its work, exactly as it
    // did before the gate existed. The app's own environment does NOT take this path — happy-dom
    // defines IntersectionObserver as a stub that never delivers an entry, so a screen test has
    // to stub a working one (see `ReportsScreen.test.tsx`).
    render(<Probe observerFactory={null} />);
    expect(reported()).toBe('true');
  });

  it('gives the fetch a head start with a generous default root margin', () => {
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} />);
    expect(observers[0]!.options?.rootMargin).toBe(DEFAULT_VIEWPORT_MARGIN);
  });

  it('honours an explicit root margin', () => {
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} rootMargin="0px" />);
    expect(observers[0]!.options?.rootMargin).toBe('0px');
  });

  it('disconnects the observer on unmount', () => {
    const { factory, observers } = makeFactory();
    render(<Probe observerFactory={factory} />);
    cleanup();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });
});
