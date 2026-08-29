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

interface Page {
  crossOriginIsolated?: boolean;
  isSecureContext?: boolean;
  hasSw?: boolean;
  /**
   * The session store to run against. Pass the same one to two `run` calls to model the reload
   * the script asks for: a fresh document, and the *surviving* `sessionStorage` behind it.
   * Nothing else carries a count across a navigation, which is why the budget lives there.
   */
  store?: Map<string, string>;
}

/** Run the bootstrap against a fake page, and hand back the controls a test needs. */
function run(page: Page = {}): Harness {
  const { crossOriginIsolated = false, isSecureContext = true, hasSw = true, store = new Map() } = page;
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

  it('has an attempt left for the document its own reload creates', () => {
    // The failure the budget exists for: the reloaded navigation was not intercepted, so it
    // came back un-isolated *and* uncontrolled, and the next worker to claim it fires the event
    // again. With a one-shot guard that second chance was already spent, and the session sat on
    // the boot screen until the tab was closed. Same store, second document — the reload the
    // first `run` asked for.
    const store = new Map<string, string>();
    run({ store }).controllerChange();
    const second = run({ store });
    second.controllerChange();
    expect(second.reloads()).toBe(1);
  });

  it('stops after the budget, so stripped headers cannot loop the page for ever', () => {
    // Across documents, because that is the only way the count is ever reached in practice —
    // an in-memory counter would satisfy a single-document version of this test and still
    // reload for ever in a browser.
    const store = new Map<string, string>();
    for (let i = 0; i < 5; i += 1) run({ store }).controllerChange();
    expect(store.get('gubbins-coi-reload-attempts')).toBe('2');
  });

  it('spends no more than the budget within one document either', () => {
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
