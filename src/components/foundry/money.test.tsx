import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { Money } from './money';

// Pin the base currency/locale so the rendered symbol is deterministic (the store's
// first-run guess reads navigator, which varies across CI hosts).
beforeEach(() => usePreferencesStore.setState({ baseCurrency: 'GBP', locale: 'en-GB' }));
afterEach(cleanup);

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
});
