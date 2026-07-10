/**
 * Tests for the Foundry scroll-reveal primitive (visual-flair F3) — the `useRevealOnScroll`
 * engine and its `<Reveal>` wrapper. Both the IntersectionObserver and the reduced-motion
 * preference are injected (no real browser APIs), so the enhance-downward contract can be
 * exercised deterministically: content is always in the DOM, only ever hidden when the reveal
 * is genuinely armed, and revealed one-shot on first intersection.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, renderHook, act, cleanup } from '@testing-library/react';
import { Reveal } from './reveal';
import {
  useRevealOnScroll,
  revealStaggerMs,
  REVEAL_STAGGER_STEP_MS,
  type IntersectionObserverFactory,
  type ObserverLike,
  type RevealOnScrollOptions,
} from './useRevealOnScroll';
import type { MediaQueryProvider } from './useReducedMotion';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'headache' });
});

/** A controllable fake IntersectionObserver that records wiring and can fire on demand. */
class FakeObserver implements ObserverLike {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {}
  /** Simulate the element (not) intersecting the viewport. */
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
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

/** A reduced-motion provider that always reports the given preference (no live changes needed). */
function motion(matches: boolean): MediaQueryProvider {
  return () => ({ matches, addEventListener() {}, removeEventListener() {} });
}

/**
 * A probe that drives the hook with the ref attached to a *real* DOM node — the realistic
 * path, where React sets the callback ref during commit (before the effect runs) so the
 * observer is wired. (`renderHook` alone has no element to attach to.)
 */
function Probe(props: RevealOnScrollOptions) {
  const { ref, revealed, armed } = useRevealOnScroll(props);
  return <div ref={ref} data-testid="probe" data-revealed={String(revealed)} data-armed={String(armed)} />;
}

describe('useRevealOnScroll', () => {
  it('does not arm under reduced motion — reveals immediately, never observes', () => {
    const { factory, observers } = makeFactory();
    const { result } = renderHook(() => useRevealOnScroll({ reduced: true, observerFactory: factory }));
    expect(result.current.armed).toBe(false);
    expect(result.current.revealed).toBe(true);
    expect(observers).toHaveLength(0);
  });

  it('does not arm when no observer is available — reveals immediately', () => {
    const { result } = renderHook(() => useRevealOnScroll({ reduced: false, observerFactory: null }));
    expect(result.current.armed).toBe(false);
    expect(result.current.revealed).toBe(true);
  });

  it('arms and holds hidden until the element first intersects (one-shot)', () => {
    const { factory, observers } = makeFactory();
    render(<Probe reduced={false} observerFactory={factory} />);
    const el = screen.getByTestId('probe');

    expect(el.dataset.armed).toBe('true');
    expect(el.dataset.revealed).toBe('false');
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledTimes(1);

    // A non-intersecting callback must NOT reveal.
    act(() => observers[0]!.fire(false));
    expect(el.dataset.revealed).toBe('false');

    // First intersection reveals and disconnects (one-shot — never re-hides on scroll-up).
    act(() => observers[0]!.fire(true));
    expect(el.dataset.revealed).toBe('true');
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it('passes the rootMargin through to the observer', () => {
    const { factory, observers } = makeFactory();
    render(<Probe reduced={false} observerFactory={factory} rootMargin="50px" />);
    expect(observers[0]!.options?.rootMargin).toBe('50px');
  });
});

describe('revealStaggerMs', () => {
  it('scales by the step and caps a long group', () => {
    expect(revealStaggerMs(0)).toBe(0);
    expect(revealStaggerMs(2)).toBe(2 * REVEAL_STAGGER_STEP_MS);
    expect(revealStaggerMs(-3)).toBe(0);
    expect(revealStaggerMs(100)).toBe(8 * REVEAL_STAGGER_STEP_MS);
  });
});

describe('<Reveal>', () => {
  it('always renders its children in the DOM (presentation only)', () => {
    const { factory } = makeFactory();
    render(
      <Reveal data-testid="r" motionProvider={motion(false)} observerFactory={factory}>
        <p>Body</p>
      </Reveal>,
    );
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('under reduced motion renders fully visible — no pending or entrance class', () => {
    const { factory, observers } = makeFactory();
    render(
      <Reveal data-testid="r" motionProvider={motion(true)} observerFactory={factory}>
        <p>Body</p>
      </Reveal>,
    );
    const el = screen.getByTestId('r');
    expect(el).not.toHaveClass('opacity-0');
    expect(el).not.toHaveClass('animate-rise');
    expect(observers).toHaveLength(0);
  });

  it('at a motion-off animation level renders fully visible even with OS motion allowed', () => {
    // The reveal holds content at a static `opacity-0` the CSS motion catch-all can't clear, so
    // the animation-level pref must skip arming entirely — otherwise below-the-fold content would
    // stay hidden until scrolled to. OS motion is allowed here (motion(false)); only the pref gates.
    usePreferencesStore.setState({ animationLevel: 'calm' });
    const { factory, observers } = makeFactory();
    render(
      <Reveal data-testid="r" motionProvider={motion(false)} observerFactory={factory}>
        <p>Body</p>
      </Reveal>,
    );
    const el = screen.getByTestId('r');
    expect(el).not.toHaveClass('opacity-0');
    expect(el).not.toHaveClass('animate-rise');
    expect(observers).toHaveLength(0);
  });

  it('holds hidden then rises on first intersection', () => {
    const { factory, observers } = makeFactory();
    render(
      <Reveal data-testid="r" motionProvider={motion(false)} observerFactory={factory}>
        <p>Body</p>
      </Reveal>,
    );
    const el = screen.getByTestId('r');
    // Armed: pending (invisible) until it scrolls into view.
    expect(el).toHaveClass('opacity-0');
    expect(el).not.toHaveClass('animate-rise');

    act(() => observers[0]!.fire(true));

    // Revealed: rises in via the shared entrance, no longer pending.
    expect(el).toHaveClass('animate-rise');
    expect(el).not.toHaveClass('opacity-0');
  });

  it('applies the per-item stagger delay only once revealed', () => {
    const { factory, observers } = makeFactory();
    render(
      <Reveal data-testid="r" index={2} motionProvider={motion(false)} observerFactory={factory}>
        <p>Body</p>
      </Reveal>,
    );
    const el = screen.getByTestId('r');
    // Pending: no delay applied yet (nothing is animating).
    expect(el.style.animationDelay).toBe('');

    act(() => observers[0]!.fire(true));
    expect(el.style.animationDelay).toBe(`${2 * REVEAL_STAGGER_STEP_MS}ms`);
  });

  it('honours the `as` prop for semantic elements', () => {
    render(
      <Reveal as="section" aria-label="Region" motionProvider={motion(true)}>
        <p>Body</p>
      </Reveal>,
    );
    expect(screen.getByRole('region', { name: 'Region' }).tagName).toBe('SECTION');
  });
});
