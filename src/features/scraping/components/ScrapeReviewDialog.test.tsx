import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ScrapeReviewDialog } from './ScrapeReviewDialog';
import type { ExistingItemFields } from '../merge';
import type { ScrapeResultPayload } from '../protocol';

/**
 * What the review dialog tells the user about a scraped **price** (issue #666).
 *
 * The dialog is the "check it before it lands" step, so a bare number is not enough: a price
 * carries a currency, and the item's own unit cost has no currency column of its own. A quote
 * in the base currency is shown as money and applied; a quote in any other currency is shown,
 * explained and withheld — it can only be recorded honestly against the supplier part.
 */

const EMPTY: ExistingItemFields = {
  mpn: null,
  manufacturer: null,
  description: null,
  unitCost: null,
  aliases: [],
};

function payload(currency: string, value: number): ScrapeResultPayload {
  return {
    mpn: 'NE555P',
    manufacturer: 'Texas Instruments',
    description: 'Precision 555 timer IC, DIP-8',
    distributor_url: 'https://www.digikey.com/product/NE555P',
    scraped_pricing: { currency, value },
  };
}

function open(existing: ExistingItemFields, result: ScrapeResultPayload, onApply = vi.fn()) {
  render(
    <ScrapeReviewDialog open existing={existing} payload={result} onApply={onApply} onClose={vi.fn()} />,
  );
  return onApply;
}

// The store guesses a base currency from the environment, so pin it per case rather than
// letting whatever the test runner's locale implies decide what counts as "foreign".
beforeEach(() => usePreferencesStore.setState({ baseCurrency: 'GBP', locale: 'en-GB' }));
afterEach(cleanup);

describe('ScrapeReviewDialog — a scraped price names its currency (issue #666)', () => {
  it('renders a base-currency price as money rather than a bare number', () => {
    open(EMPTY, payload('GBP', 4.15));
    // Money splits the tinted symbol from the digits, so assert on the combined text.
    expect(screen.getByRole('dialog')).toHaveTextContent('£4.15');
    expect(screen.queryByTestId('scrape-review-foreign-price')).not.toBeInTheDocument();
  });

  it('shows a foreign price under its own currency, and both codes in the warning', () => {
    open(EMPTY, payload('USD', 4.15));
    const warning = screen.getByTestId('scrape-review-foreign-price');
    expect(warning).toHaveTextContent('$4.15');
    expect(warning).toHaveTextContent('GBP');
    expect(warning).toHaveTextContent('USD');
  });

  it('never applies a foreign price to the item’s unit cost', () => {
    const onApply = open(EMPTY, payload('USD', 4.15));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const write = onApply.mock.calls[0]![0];
    expect(write.fields.unitCost).toBeUndefined();
    // The rest of the scrape still lands, so the price is the only thing withheld.
    expect(write.fields.mpn).toBe('NE555P');
  });

  it('keeps Apply available when a withheld price is the only news', () => {
    // Everything else already matches, so nothing fills — but the caller still records the
    // quote against the supplier part, which does carry its own currency.
    const existing: ExistingItemFields = {
      mpn: 'NE555P',
      manufacturer: 'Texas Instruments',
      description: 'Precision 555 timer IC, DIP-8',
      unitCost: null,
      aliases: ['NE555P'],
    };
    open(existing, payload('USD', 4.15));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByTestId('scrape-review-foreign-price')).toBeInTheDocument();
  });

  it('shows both sides of a cost conflict as money in their own currencies', () => {
    usePreferencesStore.setState({ baseCurrency: 'USD' });
    const conflict = { ...EMPTY, unitCost: 3.2 };
    open(conflict, payload('USD', 4.15));
    const row = screen.getByTestId('overwrite-unitCost').closest('li')!;
    expect(row).toHaveTextContent('$3.20');
    expect(row).toHaveTextContent('$4.15');
  });
});
