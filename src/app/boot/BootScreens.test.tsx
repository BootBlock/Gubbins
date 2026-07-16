import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { UnsupportedScreen } from './BootScreens';
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

afterEach(cleanup);

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
});
