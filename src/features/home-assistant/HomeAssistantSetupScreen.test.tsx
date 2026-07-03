/**
 * Smoke tests for the Home Assistant setup guide screen.
 *
 * Strategy: mock the router-facing chrome (Link, AppNav, HeaderSearch, BrandMark) and swap
 * every icon for a lightweight span, so the screen renders in happy-dom with no RouterProvider.
 * We drive the real step navigation, the branching choice cards, and the in-browser token
 * generator (which uses the real Web Crypto) to prove the interactive flow works end to end.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { ToastProvider } from '@/components/foundry';
import { HomeAssistantSetupScreen } from './HomeAssistantSetupScreen';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <div data-testid="header-search" />,
}));
vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

function renderGuide() {
  return render(
    <ToastProvider>
      <HomeAssistantSetupScreen />
    </ToastProvider>,
  );
}

describe('HomeAssistantSetupScreen', () => {
  it('starts on the overview step', () => {
    renderGuide();
    expect(screen.getByRole('heading', { level: 1, name: /Home Assistant setup/ })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 8')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
  });

  it('reveals tailored guidance when a branching choice is made', async () => {
    const user = userEvent.setup();
    renderGuide();
    expect(screen.queryByText(/we'll go through it together/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /starting from scratch/i }));
    expect(screen.getByText(/we'll go through it together/i)).toBeInTheDocument();
  });

  it('moves forward with Next and generates a real token on the token step', async () => {
    const user = userEvent.setup();
    renderGuide();

    await user.click(screen.getByTestId('guide-next'));
    expect(screen.getByText('Step 2 of 8')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Access token' })).toBeInTheDocument();

    const input = screen.getByTestId('token-input') as HTMLInputElement;
    expect(input.value).toBe('');
    await user.click(screen.getByTestId('generate-token'));
    expect(input.value).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByTestId('token-generated')).toBeInTheDocument();
  });

  it('lets the user jump to any step from the progress rail', async () => {
    const user = userEvent.setup();
    renderGuide();

    const rail = screen.getByRole('navigation', { name: /setup steps/i });
    await user.click(within(rail).getByRole('button', { name: /Try it/i }));

    expect(screen.getByText('Step 8 of 8')).toBeInTheDocument();
    expect(screen.getByTestId('guide-complete')).toBeInTheDocument();
    // The final step has no "next" control.
    expect(screen.queryByTestId('guide-next')).not.toBeInTheDocument();
  });

  it('disables Back on the first step', () => {
    renderGuide();
    expect(screen.getByTestId('guide-prev')).toBeDisabled();
  });

  it('covers Google Home and reveals the conversation-automation wiring on the sentences step', async () => {
    const user = userEvent.setup();
    renderGuide();

    const rail = screen.getByRole('navigation', { name: /setup steps/i });
    await user.click(within(rail).getByRole('button', { name: /Voice sentences/i }));

    // Google Home / Nest coverage is always shown on this step (the real-world gap).
    expect(screen.getByText(/Using a Google Home or Nest speaker/i)).toBeInTheDocument();

    // The conversation-automation branch (no file editing) is revealed on demand.
    expect(screen.queryByText('No grammar script needed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /conversation automation/i }));
    expect(screen.getByText('No grammar script needed')).toBeInTheDocument();
  });
});
