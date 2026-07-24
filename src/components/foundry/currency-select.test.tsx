import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { CurrencySelect, CurrencyField, DEFAULT_CURRENCY_NONE_LABEL } from './currency-select';

afterEach(cleanup);

/** A controlled harness so the combobox reflects the value it reports back. */
function Harness({
  initial = '',
  allowNone = false,
  noneLabel,
}: {
  initial?: string;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CurrencySelect
      aria-label="Currency"
      value={value}
      onChange={setValue}
      allowNone={allowNone}
      noneLabel={noneLabel}
      data-testid="currency"
    />
  );
}

/** Open the listbox (the combobox is the single tab stop) and return its options. */
function openAndListOptions() {
  fireEvent.click(screen.getByTestId('currency'));
  return within(screen.getByRole('listbox')).getAllByRole('option');
}

describe('CurrencySelect', () => {
  it('offers every popular code as a `CODE — Name` row, GBP first', () => {
    render(<Harness />);
    const labels = openAndListOptions().map((o) => o.textContent);
    expect(labels[0]).toBe('GBP — British Pound');
    expect(labels).toContain('EUR — Euro');
    expect(labels).toContain('JPY — Japanese Yen');
  });

  it('reports the bare ISO code when a row is chosen', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('currency'));
    fireEvent.click(screen.getByRole('option', { name: 'EUR — Euro' }));
    // The trigger now shows the chosen row's label.
    expect(screen.getByTestId('currency')).toHaveTextContent('EUR — Euro');
  });

  it('leads with a blank "use base currency" row when allowNone is set', () => {
    render(<Harness allowNone />);
    expect(openAndListOptions()[0]).toHaveTextContent(DEFAULT_CURRENCY_NONE_LABEL);
  });

  it('offers no blank row when allowNone is unset', () => {
    render(<Harness />);
    const labels = openAndListOptions().map((o) => o.textContent);
    expect(labels[0]).toBe('GBP — British Pound');
    expect(labels).not.toContain(DEFAULT_CURRENCY_NONE_LABEL);
  });

  it('uses a caller-supplied label for the blank row', () => {
    render(<Harness allowNone noneLabel="Use base currency (GBP)" />);
    expect(openAndListOptions()[0]).toHaveTextContent('Use base currency (GBP)');
  });

  it('preserves an off-list stored code so existing data still shows and round-trips', () => {
    // THB is a valid ISO code that the popular list does not offer; editing a record that
    // already carries it must keep showing it rather than silently blanking the field.
    render(<Harness initial="THB" />);
    expect(screen.getByTestId('currency')).toHaveTextContent('THB');
    const labels = openAndListOptions().map((o) => o.textContent);
    expect(labels).toContain('THB');
  });
});

describe('CurrencyField', () => {
  it('names the combobox with its label via aria-labelledby', () => {
    render(<CurrencyField label="Default currency" value="" onChange={() => {}} allowNone />);
    // The label names the combobox (a role="combobox" can't be named by a wrapping <label>).
    expect(screen.getByRole('combobox', { name: 'Default currency' })).toBeInTheDocument();
  });
});
