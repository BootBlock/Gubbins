import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Stub @tanstack/react-router's Link as a plain <a> so the header renders
// without a RouterProvider in the test.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// Stub the brand-mark image so happy-dom needs no real SVG asset.
vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// Stub the global nav (exercised in its own suite) so this one stays focused on the
// header layout and needs no router/alerts context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// Stub the command-palette search field (its own suite covers behaviour) so the layout
// tests stay focused and independent of the preferences store.
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

import { PageHeader } from './page-header';

afterEach(cleanup);

describe('PageHeader — the canonical screen header (spec §2.4.1)', () => {
  it('renders the title as the single <h1>, with the icon before it', () => {
    render(<PageHeader icon={<svg data-testid="icon" />} title="Reports & valuation" />);
    const heading = screen.getByRole('heading', { level: 1, name: /Reports & valuation/ });
    expect(heading).toBeTruthy();
    // The icon is rendered inside the heading, ahead of the text.
    expect(heading.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it('links the brand home-link to the dashboard by default, overridable via homeTo', () => {
    const { rerender } = render(<PageHeader icon={<svg />} title="Settings" />);
    expect(screen.getByText('Gubbins').closest('a')?.getAttribute('href')).toBe('/');

    rerender(<PageHeader icon={<svg />} title="Settings" homeTo="/inventory" />);
    expect(screen.getByText('Gubbins').closest('a')?.getAttribute('href')).toBe('/inventory');
  });

  it('renders page actions alongside the global nav in the right-aligned row', () => {
    render(<PageHeader icon={<svg />} title="Reports" actions={<button type="button">Export CSV</button>} />);
    const action = screen.getByRole('button', { name: 'Export CSV' });
    const row = action.parentElement;
    // Actions live in the ml-auto row, immediately before the global nav menu.
    expect(row?.className).toContain('ml-auto');
    expect(row?.querySelector('[data-testid="app-nav"]')).not.toBeNull();
  });

  it('always renders the global navigation, even on a title-only header', () => {
    render(<PageHeader icon={<svg />} title="About" />);
    // Every screen can reach every other — the nav is never omitted.
    expect(screen.getByTestId('app-nav')).toBeTruthy();
  });

  it('renders the command-palette search field by default, and omits it when hideSearch is set', () => {
    const { rerender } = render(<PageHeader icon={<svg />} title="Reports" />);
    expect(screen.getByTestId('header-search')).toBeTruthy();

    rerender(<PageHeader icon={<svg />} title="Inventory" hideSearch />);
    expect(screen.queryByTestId('header-search')).toBeNull();
  });

  it('merges extra classes onto the <header> element', () => {
    const { container } = render(<PageHeader icon={<svg />} title="Inventory" className="pb-4" />);
    const header = container.querySelector('header');
    expect(header?.className).toContain('pb-4');
    expect(header?.className).toContain('flex');
  });
});
