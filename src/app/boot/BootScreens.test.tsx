import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataLossScreen, MultiTabScreen, UnsupportedScreen } from './BootScreens';
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

/**
 * The notice a vanished database gets (issue #505). Its whole job is to stop an empty inventory
 * reading as a fresh install: it must say what actually happened, quote only what was really
 * recorded, and put a restore in front of the user *before* they start re-typing their data.
 */
describe('DataLossScreen', () => {
  const loss = { detectedAt: 1_760_000_000_000, lastSeenAt: 1_759_900_000_000, lastKnownItems: 248 };

  it('says the data is gone, and that Gubbins did not delete it', () => {
    render(<DataLossScreen loss={loss} onContinue={() => {}} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Your Gubbins data is gone' })).toBeInTheDocument();
    expect(screen.getByText(/Gubbins did not delete it/)).toBeInTheDocument();
    // The line that stops a restore turning into a merge.
    expect(screen.getByText(/before adding anything/)).toBeInTheDocument();
  });

  it('quotes what the device last held, so the user can judge whether a backup is current', () => {
    render(<DataLossScreen loss={loss} onContinue={() => {}} />);
    expect(screen.getByText(/holding 248 items/)).toBeInTheDocument();
  });

  it('invents no figure it never recorded', () => {
    render(<DataLossScreen loss={{ ...loss, lastKnownItems: null }} onContinue={() => {}} />);
    expect(screen.getByText(/This device last opened Gubbins on/)).toBeInTheDocument();
    expect(screen.queryByText(/holding/)).not.toBeInTheDocument();
  });

  it('does not quote a zero it took at the last boot', () => {
    // The count is taken when Gubbins starts, so a session that added two hundred items and never
    // restarted still records zero — "holding 0 items" would read as "nothing was lost".
    render(<DataLossScreen loss={{ ...loss, lastKnownItems: 0 }} onContinue={() => {}} />);
    expect(screen.queryByText(/holding/)).not.toBeInTheDocument();
  });

  it('admits when it cannot even date the loss', () => {
    render(
      <DataLossScreen loss={{ ...loss, lastSeenAt: null, lastKnownItems: null }} onContinue={() => {}} />,
    );
    expect(screen.getByText(/no record of when this device last opened Gubbins/)).toBeInTheDocument();
  });

  it('offers the restores and nothing that would make the situation worse', () => {
    render(<DataLossScreen loss={loss} onContinue={() => {}} />);

    expect(screen.getByRole('button', { name: /Restore full archive/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore raw \.sqlite/i })).toBeInTheDocument();
    // A backup here would capture the empty database that replaced the user's data, and the purge
    // is the very thing that has already happened.
    expect(screen.queryByRole('button', { name: /Back up everything/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hard reset|purge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reinstall app files/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export data/i })).not.toBeInTheDocument();
  });

  it('lets the user carry on once they have read it', async () => {
    const onContinue = vi.fn();
    render(<DataLossScreen loss={loss} onContinue={onContinue} />);

    await userEvent.click(screen.getByRole('button', { name: 'Continue with an empty inventory' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
