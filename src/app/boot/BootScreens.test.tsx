import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiTabScreen, UnsupportedScreen } from './BootScreens';
import { TAB_LOCK_OVERRIDE_KEY } from '@/lib/storage-keys';
import type { SupportCause, SupportDiagnosis } from '@/lib/env/support-diagnosis';

/**
 * The boot gate's support screen must present each diagnosed cause as what it *is* (issue #105):
 * an environment problem the user can fix, a first-visit wait, or — only as a last resort — an
 * unsupported browser. `support-diagnosis.test.ts` covers which cause is chosen; this covers what
 * the user is then told, which the types cannot check.
 */

const diagnosis = (cause: SupportCause): SupportDiagnosis => ({
  cause,
  missing: ['Cross-Origin Isolation (COOP/COEP)', 'SharedArrayBuffer'],
  signals: {
    crossOriginIsolated: false,
    sharedArrayBuffer: false,
    opfs: true,
    secureContext: true,
    coiBootstrapRan: true,
    localStorageUsable: true,
    cookiesEnabled: true,
    serviceWorkerApi: true,
    serviceWorkerActive: true,
    serviceWorkerControlling: false,
  },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('UnsupportedScreen', () => {
  it.each([
    ['insecure-context', 'Gubbins needs a secure connection'],
    ['scripts-blocked', 'Something is blocking part of Gubbins'],
    ['site-data-blocked', 'Gubbins isn’t allowed to store anything here'],
    ['isolation-pending', 'Preparing secure storage…'],
    ['isolation-blocked', 'Gubbins can’t finish setting up storage'],
    ['browser-unsupported', 'Browser not supported'],
  ] as const)('leads with the cause, not a catch-all: %s', (cause, heading) => {
    render(<UnsupportedScreen diagnosis={diagnosis(cause)} />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it('only blames the browser for the one cause that is the browser', () => {
    // The regression this screen exists to prevent: an environment problem reported as
    // "Browser not supported" on a browser that supports Gubbins perfectly well.
    for (const cause of [
      'insecure-context',
      'scripts-blocked',
      'site-data-blocked',
      'isolation-pending',
      'isolation-blocked',
    ] as const) {
      render(<UnsupportedScreen diagnosis={diagnosis(cause)} />);
      expect(screen.queryByText('Browser not supported'), cause).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('offers something to actually do about an environmental cause', () => {
    render(<UnsupportedScreen diagnosis={diagnosis('scripts-blocked')} />);
    const steps = within(screen.getByTestId('boot-unsupported')).getByRole('list');
    expect(within(steps).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByText('What to try')).toBeInTheDocument();
  });

  it('presents a first visit as progress, with nothing to fix', () => {
    render(<UnsupportedScreen diagnosis={diagnosis('isolation-pending')} />);
    // No "What to try" list: the page reloads itself once the worker takes control, so a list of
    // remedies would send the user chasing a problem that is about to disappear.
    expect(screen.queryByText('What to try')).not.toBeInTheDocument();
    expect(screen.getByText(/Reloading usually finishes the job/)).toBeInTheDocument();
  });

  it('reports every signal behind the verdict for a bug report', () => {
    render(<UnsupportedScreen diagnosis={diagnosis('isolation-blocked')} />);
    const report = screen.getByText(/^cause:/);
    expect(report).toHaveTextContent('cause: isolation-blocked');
    expect(report).toHaveTextContent('coiBootstrapRan: true');
    expect(report).toHaveTextContent('serviceWorkerControlling: false');
    expect(report).toHaveTextContent('missing: Cross-Origin Isolation (COOP/COEP), SharedArrayBuffer');
  });

  it('links the shared boot-screen footer to the public project home', () => {
    render(<UnsupportedScreen diagnosis={diagnosis('isolation-blocked')} />);
    const footer = screen.getByRole('link', { name: 'Gubbins · local-first inventory' });
    expect(footer).toHaveAttribute('href', 'https://github.com/BootBlock/Gubbins');
    expect(footer).toHaveAttribute('target', '_blank');
    expect(footer).toHaveAttribute('rel', 'noreferrer');
  });
});

/**
 * The single-tab guard fails closed (issue #207), so this screen now has two jobs: the familiar
 * "another tab owns it" overlay, and an honest "we could not check" state. Only the second may
 * offer the override that opens the database without arbitration — showing it in the first case
 * would invite the user to open a database another tab demonstrably has.
 */
describe('MultiTabScreen', () => {
  it('tells the user another tab owns the database, with no override on offer', () => {
    render(<MultiTabScreen reason="held" whenReleased={new Promise<void>(() => {})} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Already open elsewhere' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this tab' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open anyway/i })).not.toBeInTheDocument();
  });

  it('says it could not check — rather than claiming another tab is open — when arbitration failed', () => {
    render(<MultiTabScreen reason="unavailable" whenReleased={null} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Gubbins can’t check for other tabs' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload and try again' })).toBeInTheDocument();
  });

  it('offers the per-tab override only when ownership is unknown, and records it before reloading', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location);

    render(<MultiTabScreen reason="unavailable" whenReleased={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'This is my only tab — open anyway' }));

    // The choice must be persisted *before* the reload, or the fresh boot denies again.
    expect(sessionStorage.getItem(TAB_LOCK_OVERRIDE_KEY)).toBe('1');
    expect(reload).toHaveBeenCalled();
  });
});
