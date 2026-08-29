import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { Money } from './money';
import type { MediaQueryLike, MediaQueryProvider } from './useReducedMotion';

// Pin the base currency/locale so the rendered symbol is deterministic (the store's
// first-run guess reads navigator, which varies across CI hosts).
beforeEach(() => usePreferencesStore.setState({ baseCurrency: 'GBP', locale: 'en-GB' }));
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

describe('Money', () => {
  it('renders the value with the currency symbol tinted apart from the digits', () => {
    render(<Money value={4.25} data-testid="m" />);
    const el = screen.getByTestId('m');
    // Reads as the plain string in order (assistive tech / copy-paste parity).
    expect(el.textContent).toBe('£4.25');
    // The symbol lives in its own span carrying the token colour + 0.8 opacity…
    const symbol = el.querySelector('.text-money-symbol');
    expect(symbol).not.toBeNull();
    expect(symbol!.className).toContain('opacity-80');
    expect(symbol!.textContent).toBe('£');
    // …and the digits are NOT inside that tinted span.
    expect(symbol!.textContent).not.toContain('4.25');
  });

  it('honours a per-value currency override with no conversion', () => {
    render(<Money value={1.23} currency="EUR" data-testid="m" />);
    const el = screen.getByTestId('m');
    expect(el.textContent).toContain('€');
    expect(el.textContent).toContain('1.23');
    expect(el.textContent).not.toContain('£');
  });

  it('renders an em-dash for a non-finite value', () => {
    render(<Money value={Number.NaN} data-testid="m" />);
    expect(screen.getByTestId('m').textContent).toBe('—');
  });

  describe('animate (rolling total)', () => {
    it('keeps the tinted currency symbol while rolling, and snaps to the value under reduced motion', () => {
      // Reduced motion means the figure lands instantly with no roll — so the value is
      // deterministic to assert while still exercising the animated code path.
      render(<Money value={42} animate animateOnMount motionProvider={motion(true)} data-testid="m" />);
      const el = screen.getByTestId('m');
      expect(el.textContent).toBe('£42.00');
      // The symbol is still split out and tinted exactly as the static path.
      const symbol = el.querySelector('.text-money-symbol');
      expect(symbol).not.toBeNull();
      expect(symbol!.className).toContain('opacity-80');
      expect(symbol!.textContent).toBe('£');
      // Reduced motion must not attach the decorative settle-pop.
      expect(el.className).not.toContain('animate-count-pop');
    });

    it('carries the settle-pop when a count-in rolls and motion is permitted', () => {
      render(<Money value={42} animate animateOnMount motionProvider={motion(false)} data-testid="m" />);
      expect(screen.getByTestId('m').className).toContain('animate-count-pop');
    });

    // The pop is a settle, so it belongs to a roll. Without `animateOnMount` the display seeds at
    // the true value and nothing rolls — and since the pop is held back by the roll duration, a
    // pop here would bounce long after the figure had settled.
    it('does not pop on a plain mount, where no roll ran', () => {
      render(<Money value={42} animate motionProvider={motion(false)} data-testid="m" />);
      const el = screen.getByTestId('m');
      expect(el.textContent).toBe('£42.00');
      expect(el.className).not.toContain('animate-count-pop');
      expect(el.style.animationDelay).toBe('');
    });

    it('still renders an em-dash for a non-finite value when animating', () => {
      render(<Money value={Number.NaN} animate motionProvider={motion(true)} data-testid="m" />);
      expect(screen.getByTestId('m').textContent).toBe('—');
    });
  });
});
