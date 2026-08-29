import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
// Imported at module scope rather than with `await import('./App')` inside the test body.
// App's graph is large by design (the Foundry barrel, the scraping provider, inventory
// components, alerts) and a dynamic import charges every millisecond of loading it to the
// *test's* timeout, where the suite's own parallel transform load lands on top: the body
// measured 3.3s idle and timed out intermittently under a loaded machine. Loaded here the
// same work is import time, which no per-test budget bounds, and the body measures ~55ms.
// `vi.mock` is hoisted above this import, so the three seams below still apply.
import { App } from './App';

/**
 * Regression guard for the GitHub Pages first-visit deadlock (spec §2.2.6).
 *
 * On a static host (GitHub Pages) the browser is not cross-origin isolated until the
 * service worker (src/sw.ts) registers, activates, and injects COOP/COEP headers. That
 * registration lives *only* inside {@link PwaUpdatePrompt} (via usePwaUpdate). If it were
 * ever nested inside <BootGate> again, a fresh visit deadlocks: BootGate cannot reach
 * `ready` without isolation, isolation cannot arrive without the worker registering, and
 * the worker cannot register without PwaUpdatePrompt mounting. This test forces BootGate
 * to stay stuck on its `unsupported` branch (exactly the real first-visit condition) and
 * proves PwaUpdatePrompt still mounts — i.e. is a sibling of <BootGate>, not a descendant.
 *
 * Three seams are mocked, each for a specific reason (not to fake the composition under
 * test — App's actual JSX tree renders for real):
 *  - `checkCriticalSupport` forces the real BootGate/useDatabaseBoot state machine into
 *    `unsupported` deterministically, rather than faking `crossOriginIsolated` globally.
 *  - `@/components/PwaUpdatePrompt` becomes a mount-spy so this stays a pure composition
 *    test — it never touches the real service-worker registration seam
 *    (browserPwaUpdateApi loads the `virtual:pwa-register` module, unresolvable under Vitest).
 *  - `@/app/router` becomes an inert stub. The real `router` singleton eagerly imports the
 *    entire generated route tree (every feature screen) at module scope; that's irrelevant
 *    here since <RouterProvider> never renders while BootGate withholds `children` (it's
 *    the exact thing this test proves does NOT block PwaUpdatePrompt), but importing it for
 *    real would still pull in and evaluate every feature module for no reason.
 */

const pwaMountSpy = vi.fn();
vi.mock('@/components/PwaUpdatePrompt', () => ({
  PwaUpdatePrompt: () => {
    pwaMountSpy();
    return null;
  },
}));

vi.mock('@/app/router', () => ({ router: {} }));

vi.mock('@/lib/env/feature-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env/feature-detection')>();
  return {
    ...actual,
    checkCriticalSupport: () => ({
      supported: false,
      missing: ['Cross-Origin Isolation (COOP/COEP)', 'SharedArrayBuffer'],
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('App composition (regression: GitHub Pages first-visit COI deadlock)', () => {
  it('mounts PwaUpdatePrompt even when BootGate can never leave its unsupported state', async () => {
    render(<App />);

    // Confirm we are genuinely stuck on the boot gate's unsupported branch — the exact
    // state a fresh GitHub Pages visit starts in before isolation is established. Asserted
    // via the screen's testid, not its copy: which *cause* that screen diagnoses (and so
    // what it says) depends on the environment, and is support-diagnosis.test.ts's business.
    expect(await screen.findByTestId('boot-unsupported')).toBeInTheDocument();

    // PwaUpdatePrompt — the only thing that registers the service worker — must still
    // have mounted. If this ever fails, PwaUpdatePrompt has been nested back inside
    // <BootGate> (or something else gates it), reintroducing the deadlock.
    expect(pwaMountSpy).toHaveBeenCalled();
  });
});
