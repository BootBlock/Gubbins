import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Behaviour tests for {@link ScrapeSupplierPanel}'s app-side allow-list gate (issue #667).
 *
 * The refusal itself is the pure `classifySupplierUrl`, tested next to the allow-list; what
 * matters here is the contract the panel adds on top: a link the extension would refuse is
 * never sent, and the user is told *which* refusal applied — instead of a round-trip that
 * came back blaming the supplier and advising a retry that cannot work.
 */

vi.mock('@/features/modules/useFeature', () => ({ useFeature: () => true }));

const show = vi.fn();
vi.mock('@/components/foundry', async (orig) => ({
  ...(await orig<typeof import('@/components/foundry')>()),
  useToast: () => ({ show }),
}));

const bridge = {
  ready: true,
  requests: {} as Record<string, unknown>,
  requestScrape: vi.fn(() => 'req-1'),
  clear: vi.fn(),
};
vi.mock('../ScrapeBridgeContext', () => ({ useScrapeBridge: () => bridge }));

import { ScrapeSupplierPanel } from './ScrapeSupplierPanel';

beforeEach(() => {
  bridge.ready = true;
  bridge.requests = {};
  show.mockClear();
  bridge.requestScrape.mockClear();
});
afterEach(cleanup);

/** Render the panel, type `url` into its box and press Scrape. */
function scrape(url: string) {
  render(<ScrapeSupplierPanel onResult={vi.fn()} />);
  const input = screen.getByLabelText('Product URL');
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Scrape' }));
  return input;
}

describe('ScrapeSupplierPanel — unsupported links are answered here (issue #667)', () => {
  it('sends a supported supplier link across the bridge', () => {
    scrape('https://www.digikey.co.uk/p/ne555p');
    expect(bridge.requestScrape).toHaveBeenCalledWith('https://www.digikey.co.uk/p/ne555p');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses an unsupported site inline, naming the distributors that do work', () => {
    const input = scrape('https://example.com/product/1');

    // No round-trip: the extension's own gate would refuse this, so asking is pointless.
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    // The refused host, the real reason, and the answer the user can act on.
    expect(alert).toHaveTextContent('example.com');
    expect(alert).toHaveTextContent(/no scraper/i);
    expect(alert).toHaveTextContent(/DigiKey/);
    // Never the old wording, which blamed the supplier and prescribed an impossible retry.
    expect(alert).not.toHaveTextContent(/blocked/i);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('distinguishes an http supplier link from an unsupported site', () => {
    // The site *is* supported — only the scheme is wrong, so "no scraper for this site"
    // would be the wrong answer.
    scrape('http://www.digikey.co.uk/p/ne555p');
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/only https/i);
  });

  it('does not offer the https fix for a link that is unsupported anyway', () => {
    // `http://example.com/…` fails both checks. "Try the https:// version" would send the user
    // round the same loop the issue is about, so the unsupported site is the answer given.
    scrape('http://example.com/product/1');
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/no scraper/i);
    expect(alert).not.toHaveTextContent(/only https/i);
  });

  it('explains a link that is not a web address at all', () => {
    scrape('NE555P');
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/not a web address/i);
  });

  it('explains a link carrying embedded credentials', () => {
    scrape('https://user:pw@www.digikey.co.uk/p/ne555p');
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/username and password/i);
  });

  it('clears the refusal as soon as the link is edited, and then scrapes', () => {
    const input = scrape('https://example.com/product/1');
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'https://www.mouser.com/ProductDetail/abc' } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Scrape' }));
    expect(bridge.requestScrape).toHaveBeenCalledWith('https://www.mouser.com/ProductDetail/abc');
  });

  it('submits on Enter, and refuses on Enter too', () => {
    render(<ScrapeSupplierPanel onResult={vi.fn()} />);
    const input = screen.getByLabelText('Product URL');
    fireEvent.change(input, { target: { value: 'https://example.com/p/1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(bridge.requestScrape).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
