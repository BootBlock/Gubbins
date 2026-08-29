import { describe, it, expect, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { AnimatedNumber } from './animated-number';
import type { MediaQueryLike, MediaQueryProvider } from './useReducedMotion';

afterEach(cleanup);

/** A fake reduced-motion provider fixed at `matches`. */
function motion(matches: boolean): MediaQueryProvider {
  const media: MediaQueryLike = {
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return vi.fn(() => media);
}

describe('AnimatedNumber (Foundry ticker; spec §3)', () => {
  it('shows the true value immediately on mount (no count-in by default)', () => {
    render(<AnimatedNumber value={42} motionProvider={motion(false)} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('applies the custom formatter', () => {
    render(
      <AnimatedNumber value={1234} format={(n) => `£${Math.round(n)}`} motionProvider={motion(false)} />,
    );
    expect(screen.getByText('£1234')).toBeInTheDocument();
  });

  it('snaps straight to the target under reduced motion (no roll, no pop class)', () => {
    render(<AnimatedNumber value={7} motionProvider={motion(true)} data-testid="n" />);
    const span = screen.getByTestId('n');
    expect(span).toHaveTextContent('7');
    // Reduced motion must not attach the decorative pop.
    expect(span.className).not.toContain('animate-count-pop');
  });

  it('lands exactly on the new value after a change (reduced motion path is synchronous)', () => {
    const { rerender } = render(<AnimatedNumber value={10} motionProvider={motion(true)} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    act(() => {
      rerender(<AnimatedNumber value={25} motionProvider={motion(true)} />);
    });
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('carries the pop class when motion is permitted', () => {
    render(<AnimatedNumber value={3} motionProvider={motion(false)} data-testid="n" />);
    expect(screen.getByTestId('n').className).toContain('animate-count-pop');
  });

  // The pop is a *settle*, so it must not fire while the figure is still climbing. It is held
  // back by exactly the roll duration; without the delay a long headline roll pops on the way up.
  it('delays the settle-pop by the roll duration', () => {
    render(<AnimatedNumber value={3} durationMs={1950} motionProvider={motion(false)} data-testid="n" />);
    expect(screen.getByTestId('n').style.animationDelay).toBe('1950ms');
  });

  /*
   * React double-invokes effects in development. The roll used to start from the target its own
   * torn-down first pass had recorded, so `from === to` on the second pass and the count-in
   * snapped — invisible under `npm run dev` while working in a production build. The roll now
   * starts from the figure actually on screen, so the surviving pass climbs from 0.
   */
  it('still counts in under StrictMode double-invoked effects', () => {
    // A frame loop that really cancels: the torn-down first pass must stop stepping, or the test
    // cannot tell a snap apart from a roll driven by an abandoned loop.
    const live = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      const id = nextId++;
      live.set(id, cb);
      return id;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => {
      live.delete(id);
    });
    /** Run every armed callback once at `now`, as a real frame would. */
    const frame = (now: number) => {
      const due = [...live.entries()];
      live.clear();
      act(() => {
        for (const [, cb] of due) cb(now);
      });
    };

    try {
      render(
        <StrictMode>
          <AnimatedNumber
            value={1000}
            durationMs={1000}
            animateOnMount
            motionProvider={motion(false)}
            data-testid="n"
          />
        </StrictMode>,
      );
      // No frame has run yet, so a working count-in is still at its zero start. A snap would
      // already read 1,000 here.
      expect(screen.getByTestId('n')).toHaveTextContent('0');

      frame(100);
      frame(350); // a quarter of the way through the roll

      const shown = Number(screen.getByTestId('n').textContent?.replace(/[^\d]/g, ''));
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(1000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
