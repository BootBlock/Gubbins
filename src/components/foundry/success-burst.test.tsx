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
import { buildBurstParticles, BURST_PARTICLE_COUNT, BURST_DURATION_MS } from './success-burst-geometry';
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

  it('alternates the two accent hues and keeps offsets/sizes bounded', () => {
    const reach = 900;
    const particles = buildBurstParticles(BURST_PARTICLE_COUNT, () => 0.5, reach);
    expect(particles[0]!.hue).toBe('primary');
    expect(particles[1]!.hue).toBe('highlight');
    for (const p of particles) {
      // No spark travels further than the reach it was laid out for.
      expect(Math.hypot(p.dx, p.dy)).toBeLessThanOrEqual(reach + 0.001);
      expect(p.drop).toBeGreaterThanOrEqual(0);
      expect(p.size).toBeGreaterThanOrEqual(6);
      expect(p.size).toBeLessThanOrEqual(16);
      expect(p.delayMs).toBeGreaterThanOrEqual(0);
      // Every flight lands inside the 3–5s the effect is meant to occupy.
      expect(p.durationMs).toBeGreaterThanOrEqual(3000);
      expect(p.durationMs + p.delayMs).toBeLessThanOrEqual(BURST_DURATION_MS);
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
    // The keyframe reads these custom props as the spark's outward end-point.
    expect(first.style.getPropertyValue('--burst-dx')).not.toBe('');
    expect(first.style.getPropertyValue('--burst-dy')).not.toBe('');
    // …plus the gravity sag and this spark's own flight time.
    expect(first.style.getPropertyValue('--burst-drop')).not.toBe('');
    expect(first.style.getPropertyValue('--burst-duration')).not.toBe('');
    // Colour comes from an accent-tracking brand token, never a raw literal.
    expect(first.style.backgroundColor).toContain('var(--primary)');
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
