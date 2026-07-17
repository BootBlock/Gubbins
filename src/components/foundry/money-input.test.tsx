import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { MoneyInput } from './money-input';

// Pin the base currency/locale so the fraction-digit snap is deterministic across CI hosts.
beforeEach(() => usePreferencesStore.setState({ baseCurrency: 'GBP', locale: 'en-GB' }));
afterEach(cleanup);

/** A controlled harness so the input reflects the value MoneyInput reports back. */
function Harness({ currency }: { currency?: string }) {
  const [value, setValue] = useState('');
  return <MoneyInput value={value} onValueChange={setValue} currency={currency} aria-label="Price" />;
}

describe('MoneyInput', () => {
  it('snaps a bare integer to the base currency’s fraction digits on blur', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8' } });
    expect(input.value).toBe('8'); // untouched while editing
    fireEvent.blur(input);
    expect(input.value).toBe('8.00'); // GBP → two decimals
  });

  it('leaves a blank value blank on blur (price is optional)', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.blur(input);
    expect(input.value).toBe('');
  });

  it('snaps to an override currency’s digits (e.g. JPY → zero decimals)', () => {
    render(<Harness currency="JPY" />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8.4' } });
    fireEvent.blur(input);
    expect(input.value).toBe('8');
  });
});
