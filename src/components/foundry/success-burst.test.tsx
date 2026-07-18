/**
 * Tests for the Foundry milestone success burst (visual-flair F4) — the pure particle geometry,
 * the `BurstProvider` + `useBurst` imperative trigger, and its contracts: a fire renders a capped
 * set of decorative particles that self-clean after the animation; reduced motion renders **no**
 * particle at all; and `useBurst` without a provider is a safe no-op. The reduced-motion
 * preference and the RNG are injected, and timers are faked, so nothing depends on a real browser
 * or on rAF timing (happy-dom gives neither).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { BurstProvider, useBurst } from './success-burst';
import {
  buildBurstParticles,
  sparkColour,
  BURST_PARTICLE_COUNT,
  BURST_DURATION_MS,
  BURST_HUE_SPREAD,
} from './success-burst-geometry';
import type { MediaQueryProvider } from './useReducedMotion';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// The burst is a "flourish" (suppressed at the Balanced default and calmer), so these fire-path
// tests set the everything-on `headache` level; the OS reduced-motion side is injected per test.
beforeEach(() => usePreferencesStore.setState({ animationLevel: 'headache' }));
afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ animationLevel: 'balanced' });
});

/** A reduced-motion provider that always reports the given preference. */
function motion(matches: boolean): MediaQueryProvider {
  return () => ({ matches, addEventListener() {}, removeEventListener() {} });
}

/** A trigger button that fires a burst on click — the realistic imperative call path. */
function Trigger() {
  const { burst } = useBurst();
  return (
    <button type="button" onClick={() => burst()}>
      go
    </button>
  );
}

describe('buildBurstParticles', () => {
  it('caps the particle count and never returns negatives', () => {
    expect(buildBurstParticles(1000)).toHaveLength(BURST_PARTICLE_COUNT);
    expect(buildBurstParticles(-5)).toHaveLength(0);
    expect(buildBurstParticles(6)).toHaveLength(6);
  });

  it('defaults to the capped count', () => {
    expect(buildBurstParticles()).toHaveLength(BURST_PARTICLE_COUNT);
  });

  it('keeps every ejection, size, fall and flight time bounded', () => {
    const reach = 900;
    const particles = buildBurstParticles(BURST_PARTICLE_COUNT, () => 0.5, reach);
    for (const p of particles) {
      // No spark is ejected further than the reach it was laid out for.
      expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(reach + 0.001);
      // Gravity only ever pulls down.
      expect(p.gravity).toBeGreaterThan(0);
      expect(p.size).toBeGreaterThanOrEqual(5);
      expect(p.size).toBeLessThanOrEqual(13);
      expect(p.delayMs).toBeGreaterThanOrEqual(0);
      // Every flight lands inside the 3–5s the effect is meant to occupy.
      expect(p.durationMs).toBeGreaterThanOrEqual(3000);
      expect(p.durationMs + p.delayMs).toBeLessThanOrEqual(BURST_DURATION_MS);
    }
  });

  it('spreads the sparks around the accent hue rather than giving them all one colour', () => {
    // A real RNG, since the point of the assertion is that the shell is *varied*.
    const particles = buildBurstParticles(BURST_PARTICLE_COUNT);
    const shifts = particles.map((p) => p.hueShift);

    // Varied…
    expect(new Set(shifts).size).toBeGreaterThan(8);
    // …but centred on the token's own hue, not scattered across the wheel.
    for (const p of particles) {
      expect(Math.abs(p.hueShift)).toBeLessThanOrEqual(BURST_HUE_SPREAD);
      // Embers only ever burn hotter than the base accent, never duller.
      expect(p.lightnessLift).toBeGreaterThanOrEqual(0);
      expect(p.lightnessLift).toBeLessThanOrEqual(0.16);
    }
  });

  it('scales the sparks to the reach it is given, and clamps an absurd one', () => {
    const near = buildBurstParticles(8, () => 0.9, 300);
    const far = buildBurstParticles(8, () => 0.9, 1200);
    expect(Math.hypot(far[0]!.dx, far[0]!.dy)).toBeGreaterThan(Math.hypot(near[0]!.dx, near[0]!.dy));

    // A reach beyond the clamp band can't produce an unbounded burst.
    const absurd = buildBurstParticles(8, () => 1, 100_000);
    for (const p of absurd) expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(1600.001);
  });

  it('builds each spark colour as an offset from the accent token, never a literal', () => {
    const [p] = buildBurstParticles(1, () => 0.75, 600);
    const colour = sparkColour(p!);
    // The token is the centre point — the accent still drives the whole shell.
    expect(colour).toContain('var(--primary)');
    // …offset in hue and lifted in lightness, rather than replaced by a raw colour value.
    expect(colour).toMatch(/^oklch\(from var\(--primary\) calc\(l \+ [\d.]+\) c calc\(h \+ -?\d+\)\)$/);
  });

  it('is deterministic for a given RNG', () => {
    const rng = () => 0.25;
    expect(buildBurstParticles(4, rng)).toEqual(buildBurstParticles(4, rng));
  });
});

describe('BurstProvider / useBurst', () => {
  it('renders a capped, aria-hidden burst on fire', () => {
    render(
      <BurstProvider motionProvider={motion(false)} rng={() => 0.5}>
        <Trigger />
      </BurstProvider>,
    );
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('go'));

    const overlay = screen.getByTestId('burst-overlay');
    expect(overlay).toHaveAttribute('aria-hidden');
    expect(overlay.className).toContain('pointer-events-none');
    expect(screen.getAllByTestId('burst-particle')).toHaveLength(BURST_PARTICLE_COUNT);
  });

  it('carries the outward offset + accent colour on each particle', () => {
    render(
      <BurstProvider motionProvider={motion(false)} rng={() => 0.5}>
        <Trigger />
      </BurstProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    const first = screen.getAllByTestId('burst-particle')[0]!;
    // The keyframe reads these custom props as the spark's ejection vector…
    expect(first.style.getPropertyValue('--burst-dx')).not.toBe('');
    expect(first.style.getPropertyValue('--burst-dy')).not.toBe('');
    // …the gravity fall it applies on its own curve, and this spark's own flight time. The fall
    // stays a separate variable from the ejection: the keyframe combines them, it can't unpick a
    // pre-summed end-point back into two different curves.
    expect(first.style.getPropertyValue('--burst-gravity')).not.toBe('');
    expect(first.style.getPropertyValue('--burst-duration')).not.toBe('');
    // The plain token stays as the cascade fallback wherever relative colour is unsupported —
    // including this test DOM, whose CSS parser drops the inline colour exactly as such a browser
    // would. (`sparkColour` itself is asserted directly above.)
    expect(first).toHaveClass('bg-primary');
    expect(first).toHaveClass('animate-burst-spark');
  });

  it('renders nothing under reduced motion — no overlay, no particle', () => {
    render(
      <BurstProvider motionProvider={motion(true)} rng={() => 0.5}>
        <Trigger />
      </BurstProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('burst-particle')).toHaveLength(0);
  });

  it('retires the oldest burst rather than stacking them without limit', () => {
    render(
      <BurstProvider motionProvider={motion(false)} rng={() => 0.5}>
        <Trigger />
      </BurstProvider>,
    );
    // Each burst now lives for seconds, so repeated fires overlap; the worst case must stay bounded.
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByText('go'));
    expect(screen.getAllByTestId('burst')).toHaveLength(3);
    expect(screen.getAllByTestId('burst-particle')).toHaveLength(3 * BURST_PARTICLE_COUNT);
  });

  it('self-cleans once the animation has run (no lingering DOM)', () => {
    vi.useFakeTimers();
    try {
      render(
        <BurstProvider motionProvider={motion(false)} rng={() => 0.5}>
          <Trigger />
        </BurstProvider>,
      );
      act(() => {
        fireEvent.click(screen.getByText('go'));
      });
      expect(screen.getByTestId('burst-overlay')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(BURST_DURATION_MS + 100);
      });
      expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('useBurst without a provider is a safe no-op', () => {
    // A decoration must never throw or break a screen when the provider is absent.
    expect(() => render(<Trigger />)).not.toThrow();
    expect(() => fireEvent.click(screen.getByText('go'))).not.toThrow();
  });
});
