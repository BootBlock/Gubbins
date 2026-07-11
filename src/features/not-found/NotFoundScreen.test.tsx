/**
 * Component tests for the 404 screen (issue #41).
 *
 * Strategy: stub the router seam (`Link` → plain `<a>`, `useRouterState` → a controllable
 * pathname) and the global nav so the screen renders in happy-dom without a RouterProvider.
 * The i18n and Modular-UI stores run for real (their defaults enable every destination), so
 * the assertions exercise the actual `t()` copy and the real suggestion ranking.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// A controllable pathname for the mocked router state, set per test.
let mockPathname = '/notreal';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { NotFoundScreen } from './NotFoundScreen';

afterEach(cleanup);

describe('NotFoundScreen', () => {
  it('renders the styled 404 heading and the attempted path', () => {
    mockPathname = '/notreal';
    render(<NotFoundScreen />);
    expect(screen.getByRole('heading', { level: 1, name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByText("We couldn't find that page")).toBeInTheDocument();
    expect(screen.getByText('/notreal')).toBeInTheDocument();
    // A dashboard call-to-action is always offered.
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toHaveAttribute('href', '/');
  });

  it('offers a "did you mean" suggestion for a mistyped path', () => {
    mockPathname = '/inventroy';
    render(<NotFoundScreen />);
    expect(screen.getByText(/did you mean/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inventory/i })).toHaveAttribute('href', '/inventory');
  });

  it('shows no suggestions for a genuinely unrecognisable path', () => {
    mockPathname = '/zzzzzzz';
    render(<NotFoundScreen />);
    expect(screen.queryByText(/did you mean/i)).not.toBeInTheDocument();
  });
});
