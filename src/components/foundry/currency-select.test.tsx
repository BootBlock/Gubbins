import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { CurrencySelect, CurrencyAutocompleteField } from './currency-select';
import { currencyCodeFromInput } from './currency-options';

afterEach(cleanup);

describe('currencyCodeFromInput', () => {
  it('reduces a chosen "CODE — Name" row to its bare code', () => {
    expect(currencyCodeFromInput('EUR — Euro')).toBe('EUR');
  });
  it('upper-cases a free-typed code', () => {
    expect(currencyCodeFromInput('thb')).toBe('THB');
  });
});

/** Controlled harness for the select-only picker. */
function SelectHarness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <CurrencySelect aria-label="Base currency" value={value} onChange={setValue} data-testid="cur" />;
}

describe('CurrencySelect (select-only)', () => {
  it('offers every popular code as a `CODE — Name` row, GBP first', () => {
    render(<SelectHarness />);
    fireEvent.click(screen.getByTestId('cur'));
    const labels = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels[0]).toBe('GBP — British Pound');
    expect(labels).toContain('EUR — Euro');
  });

  it('reports the bare ISO code when a row is chosen', () => {
    render(<SelectHarness />);
    fireEvent.click(screen.getByTestId('cur'));
    fireEvent.click(screen.getByRole('option', { name: 'EUR — Euro' }));
    expect(screen.getByTestId('cur')).toHaveTextContent('EUR — Euro');
  });

  it('preserves an off-list stored code so existing data still shows', () => {
    render(<SelectHarness initial="THB" />);
    expect(screen.getByTestId('cur')).toHaveTextContent('THB');
  });
});

/** Controlled harness for the editable field. */
function AutoHarness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <CurrencyAutocompleteField label="Currency" value={value} onChange={setValue} data-testid="cur" />;
}

describe('CurrencyAutocompleteField (editable)', () => {
  it('renders a free-text combobox with an (i) hint', () => {
    render(<AutoHarness />);
    const input = screen.getByRole('combobox', { name: 'Currency' });
    expect(input.tagName).toBe('INPUT');
    // The (i) hint badge is present alongside the field (its generic name never collides
    // with the field's own label — see InfoHint).
    expect(screen.getByRole('img', { name: 'More information' })).toBeInTheDocument();
  });

  it('normalises free-typed text to an upper-cased ISO code', () => {
    render(<AutoHarness />);
    const input = screen.getByRole('combobox', { name: 'Currency' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'eur' } });
    expect(input.value).toBe('EUR');
  });

  it('lets the user type a code outside the popular list', () => {
    render(<AutoHarness />);
    const input = screen.getByRole('combobox', { name: 'Currency' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'thb' } });
    expect(input.value).toBe('THB');
  });

  it('offers the popular currencies as a filtered dropdown and stores the picked code', () => {
    render(<AutoHarness />);
    const input = screen.getByRole('combobox', { name: 'Currency' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'eu' } });
    // The dropdown offers the labelled row; choosing it stores the bare code.
    fireEvent.mouseDown(screen.getByRole('option', { name: 'EUR — Euro' }));
    expect(input.value).toBe('EUR');
  });
});
