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

  it('pads a bare integer to an override currency’s digits (e.g. JPY → whole)', () => {
    render(<Harness currency="JPY" />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.blur(input);
    expect(input.value).toBe('8'); // JPY → no decimals added
  });

  it('never rounds away precision the user typed (issue #290)', () => {
    // A fractional figure under a zero-decimal currency must survive the blur unchanged —
    // snapping is presentation-only, not a lossy round-trip into form state (and the DB).
    render(<Harness currency="JPY" />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1234.56' } });
    fireEvent.blur(input);
    expect(input.value).toBe('1234.56');
  });

  it('keeps a longer-than-currency unit cost intact on blur (issue #290)', () => {
    // A legitimately 4-decimal GBP unit cost (e.g. per-resistor pricing) is not truncated to 2dp.
    render(<Harness />);
    const input = screen.getByLabelText('Price') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.0125' } });
    fireEvent.blur(input);
    expect(input.value).toBe('0.0125');
  });
});
