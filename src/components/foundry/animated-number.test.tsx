import { describe, it, expect, afterEach, vi } from 'vitest';
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
});
