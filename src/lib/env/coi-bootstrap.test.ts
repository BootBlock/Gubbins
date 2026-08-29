import { readFileSync } from 'node:fs';
import { repoPath } from '../../test/repo-path';
import { describe, expect, it } from 'vitest';

/**
 * `public/coi-bootstrap.js` is a plain static asset — no module system, no imports, and nothing
 * that a type-check or the app's own tests would ever exercise. So it is run here for real:
 * the file is read from disk and evaluated with `window`, `navigator` and `sessionStorage`
 * passed in as parameters, which shadow the globals of the same name inside it.
 *
 * What is being pinned is the reload budget (issue #260). One reload was too few — a session
 * that spent its single attempt on a navigation that did not come back isolated had no way out
 * of the boot screen but closing the tab — and an unbounded number would loop for ever on an
 * origin whose COOP/COEP headers are stripped in transit.
 */
const SOURCE = readFileSync(repoPath(import.meta.dirname, 'public', 'coi-bootstrap.js'), 'utf8');

interface Harness {
  /** Fire `controllerchange` at whatever the script registered, if anything. */
  controllerChange(): void;
  /** How many times the script asked for a reload. */
  reloads(): number;
  window: Record<string, unknown>;
}

/** Run the bootstrap against a fake page, and hand back the controls a test needs. */
function run(
  page: { crossOriginIsolated?: boolean; isSecureContext?: boolean; hasSw?: boolean } = {},
): Harness {
  const { crossOriginIsolated = false, isSecureContext = true, hasSw = true } = page;
  const listeners = new Set<() => void>();
  let reloads = 0;

  const window: Record<string, unknown> = {
    crossOriginIsolated,
    isSecureContext,
    location: {
      reload: () => {
        reloads += 1;
      },
    },
  };
  const navigator = hasSw
    ? { serviceWorker: { addEventListener: (_type: string, fn: () => void) => listeners.add(fn) } }
    : {};
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };

  new Function('window', 'navigator', 'sessionStorage', SOURCE)(window, navigator, sessionStorage);

  return {
    controllerChange: () => listeners.forEach((fn) => fn()),
    reloads: () => reloads,
    window,
  };
}

describe('coi-bootstrap.js — the isolation reload budget', () => {
  it('sets the exact global support-diagnosis reads', () => {
    // The bootstrap cannot import COI_BOOTSTRAP_MARKER, so the name is duplicated there. If they
    // drift, every visitor is told their scripts are blocked. (The constant is asserted against
    // the file's text in `support-diagnosis.test.ts`; here it is the *running* script that sets
    // it, before any of its own early returns.)
    expect(run({ crossOriginIsolated: true }).window.__gubbinsCoiBootstrapRan).toBe(true);
  });

  it('reloads once a worker takes control of an un-isolated page', () => {
    const page = run();
    page.controllerChange();
    expect(page.reloads()).toBe(1);
  });

  it('reloads a second time when the first attempt did not come back isolated', () => {
    // The failure this budget exists for: the reload landed before the worker's headers applied
    // to the navigation, so the page came back exactly as un-isolated as it went in. With a
    // one-shot guard the session was then stuck on the boot screen until the tab was closed.
    const page = run();
    page.controllerChange();
    page.controllerChange();
    expect(page.reloads()).toBe(2);
  });

  it('stops after the budget, so stripped headers cannot loop the page for ever', () => {
    const page = run();
    for (let i = 0; i < 10; i += 1) page.controllerChange();
    expect(page.reloads()).toBe(2);
  });

  it('does nothing at all on a page that is already isolated', () => {
    const page = run({ crossOriginIsolated: true });
    page.controllerChange();
    expect(page.reloads()).toBe(0);
  });

  it('does nothing where there is no service worker to supply the headers', () => {
    expect(() => run({ hasSw: false }).controllerChange()).not.toThrow();
    expect(run({ hasSw: false }).reloads()).toBe(0);
  });

  it('does nothing on an insecure origin, where no worker may register anyway', () => {
    const page = run({ isSecureContext: false });
    page.controllerChange();
    expect(page.reloads()).toBe(0);
  });
});
