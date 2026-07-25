import { readFileSync } from 'node:fs';
import { repoPath } from '../../test/repo-path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COI_BOOTSTRAP_MARKER,
  SERVICE_WORKER_PROBE_TIMEOUT_MS,
  collectSupportSignals,
  diagnoseSupport,
  type SupportSignals,
} from './support-diagnosis';

/**
 * The boot gate's "Browser not supported" screen used to blame the browser for every failed
 * capability check (issue #105), when in practice a capable browser lands there because of a
 * blocked script, blocked site data, an insecure origin, or a service worker that has not taken
 * control yet. These tests pin the decision table that tells those apart — especially its
 * *order*, which is what stops a downstream symptom being reported as the root cause.
 */

/** Every signal healthy. Each case below breaks exactly what its scenario would break. */
const HEALTHY: SupportSignals = {
  crossOriginIsolated: true,
  sharedArrayBuffer: true,
  opfs: true,
  secureContext: true,
  coiBootstrapRan: true,
  localStorageUsable: true,
  cookiesEnabled: true,
  serviceWorkerApi: true,
  serviceWorkerActive: true,
  serviceWorkerControlling: true,
};

const signals = (overrides: Partial<SupportSignals> = {}): SupportSignals => ({
  ...HEALTHY,
  ...overrides,
});

/** Isolation is what a static host's service worker supplies; without it these two go. */
const NOT_ISOLATED = { crossOriginIsolated: false, sharedArrayBuffer: false } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('diagnoseSupport', () => {
  it('blames the connection when the page is not a secure context', () => {
    // An insecure origin withholds OPFS, service workers and SharedArrayBuffer all at once,
    // so every other signal is merely an echo of this one.
    const cause = diagnoseSupport(
      signals({
        ...NOT_ISOLATED,
        secureContext: false,
        opfs: false,
        coiBootstrapRan: false,
        serviceWorkerApi: false,
        serviceWorkerActive: false,
        serviceWorkerControlling: false,
      }),
    );
    expect(cause).toBe('insecure-context');
  });

  it('reports a blocked script when its own bootstrap never ran', () => {
    // The bootstrap is a same-origin <script src> in <head>: if app code runs and it did not,
    // something removed it in transit.
    expect(diagnoseSupport(signals({ ...NOT_ISOLATED, coiBootstrapRan: false }))).toBe('scripts-blocked');
  });

  it.each([
    ['localStorage throws', { localStorageUsable: false }],
    ['cookies are disabled', { cookiesEnabled: false }],
  ])('reports blocked site data when %s', (_label, blocked) => {
    expect(diagnoseSupport(signals({ ...NOT_ISOLATED, ...blocked }))).toBe('site-data-blocked');
  });

  it('treats a registered-but-not-yet-controlling worker as still starting up', () => {
    // The normal first visit: the worker is active but its COOP/COEP headers only apply from the
    // next navigation, which coi-bootstrap.js triggers on `controllerchange`.
    expect(
      diagnoseSupport(
        signals({ ...NOT_ISOLATED, serviceWorkerActive: true, serviceWorkerControlling: false }),
      ),
    ).toBe('isolation-pending');
  });

  it.each([
    [
      'the API is absent entirely (e.g. a private window)',
      { serviceWorkerApi: false, serviceWorkerActive: false, serviceWorkerControlling: false },
    ],
    ['no registration ever becomes active', { serviceWorkerActive: false, serviceWorkerControlling: false }],
    ['a worker controls the page yet isolation still never arrives', { serviceWorkerControlling: true }],
  ])('reports blocked isolation when %s', (_label, worker) => {
    expect(diagnoseSupport(signals({ ...NOT_ISOLATED, ...worker }))).toBe('isolation-blocked');
  });

  it('blames the browser only once everything else checks out', () => {
    // Isolated, allowed to store, nothing blocked — a genuinely absent capability.
    expect(diagnoseSupport(signals({ opfs: false }))).toBe('browser-unsupported');
  });

  describe('precedence — the first cause found must be the root, not a symptom', () => {
    it('an insecure context outranks everything downstream of it', () => {
      const everythingBroken = signals({
        ...NOT_ISOLATED,
        secureContext: false,
        opfs: false,
        coiBootstrapRan: false,
        localStorageUsable: false,
        cookiesEnabled: false,
        serviceWorkerApi: false,
        serviceWorkerActive: false,
        serviceWorkerControlling: false,
      });
      expect(diagnoseSupport(everythingBroken)).toBe('insecure-context');
    });

    it('a blocked script outranks the storage it would have set up', () => {
      expect(
        diagnoseSupport(signals({ ...NOT_ISOLATED, coiBootstrapRan: false, localStorageUsable: false })),
      ).toBe('scripts-blocked');
    });

    it('blocked site data outranks the worker it prevents from starting', () => {
      expect(
        diagnoseSupport(signals({ ...NOT_ISOLATED, cookiesEnabled: false, serviceWorkerActive: false })),
      ).toBe('site-data-blocked');
    });

    it('missing OPFS outranks the isolation questions, which only pick a VFS', () => {
      // Since #255 an un-isolated browser still runs Gubbins, on the opfs-sahpool VFS — so with
      // the environment causes ruled out, no OPFS really is the browser, and pointing the reader
      // at COOP/COEP headers would send them after something that would not help.
      expect(
        diagnoseSupport(signals({ ...NOT_ISOLATED, opfs: false, serviceWorkerControlling: false })),
      ).toBe('browser-unsupported');
    });

    it('still blames the environment for missing OPFS when site data is blocked', () => {
      // The precedence above only holds once the everyday explanations are out of the way.
      expect(diagnoseSupport(signals({ opfs: false, cookiesEnabled: false }))).toBe('site-data-blocked');
    });
  });
});

describe('collectSupportSignals', () => {
  /** The narrow slice of `navigator` the collector touches. */
  function stubNavigator(serviceWorker: unknown, cookieEnabled = true) {
    vi.stubGlobal(
      'navigator',
      serviceWorker === undefined ? { cookieEnabled } : { cookieEnabled, serviceWorker },
    );
  }

  it('reads the bootstrap marker the static script sets', async () => {
    stubNavigator(undefined);
    vi.stubGlobal(COI_BOOTSTRAP_MARKER, true);
    await expect(collectSupportSignals()).resolves.toMatchObject({ coiBootstrapRan: true });
  });

  it('treats a missing bootstrap marker as "did not run"', async () => {
    stubNavigator(undefined);
    await expect(collectSupportSignals()).resolves.toMatchObject({ coiBootstrapRan: false });
  });

  it.each([
    [
      'the origin is blocked outright',
      {
        setItem() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      },
    ],
    [
      // A read-only store passes a read probe but is still useless to Gubbins, which must write.
      'reads are allowed but writes are refused',
      {
        getItem: () => null,
        setItem() {
          throw new DOMException('Quota exceeded.', 'QuotaExceededError');
        },
      },
    ],
  ])('treats localStorage as blocked site data when %s', async (_label, store) => {
    stubNavigator(undefined);
    vi.stubGlobal('localStorage', store);
    await expect(collectSupportSignals()).resolves.toMatchObject({ localStorageUsable: false });
  });

  it('leaves nothing behind when the storage probe succeeds', async () => {
    stubNavigator(undefined);
    const removed: string[] = [];
    vi.stubGlobal('localStorage', {
      setItem: () => {},
      removeItem: (key: string) => removed.push(key),
    });
    await expect(collectSupportSignals()).resolves.toMatchObject({ localStorageUsable: true });
    expect(removed).toHaveLength(1);
  });

  it('waits for a service worker that is still activating rather than calling it absent', async () => {
    let activate = () => {};
    stubNavigator({ ready: new Promise<void>((resolve) => (activate = resolve)), controller: null });

    const collected = collectSupportSignals();
    activate();

    await expect(collected).resolves.toMatchObject({ serviceWorkerApi: true, serviceWorkerActive: true });
  });

  it('gives up on a service worker that never activates, so the boot screen can still answer', async () => {
    vi.useFakeTimers();
    // `navigator.serviceWorker.ready` never rejects — it simply never settles — so only the
    // timeout can turn "not yet" into a decidable "no".
    stubNavigator({ ready: new Promise<void>(() => {}), controller: null });

    const collected = collectSupportSignals();
    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_PROBE_TIMEOUT_MS);

    await expect(collected).resolves.toMatchObject({
      serviceWorkerApi: true,
      serviceWorkerActive: false,
      serviceWorkerControlling: false,
    });
  });
});

describe('coi-bootstrap.js', () => {
  it('sets the exact global support-diagnosis reads', () => {
    // The bootstrap is a static asset and cannot import COI_BOOTSTRAP_MARKER, so the name is
    // duplicated there. If they drift, every visitor is told their scripts are blocked.
    // (Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.)
    const bootstrap = readFileSync(repoPath(import.meta.dirname, 'public', 'coi-bootstrap.js'), 'utf8');
    expect(bootstrap).toContain(`window.${COI_BOOTSTRAP_MARKER} = true`);
  });
});
