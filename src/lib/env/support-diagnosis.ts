/**
 * Why the critical-support check failed — and whether it is really the *browser's* fault.
 *
 * `checkCriticalSupport` (feature-detection.ts) answers "can Gubbins run here?"; it deliberately
 * says nothing about *why* not. Answering only that is misleading, because the three things it requires
 * (cross-origin isolation, `SharedArrayBuffer`, OPFS) are withheld by a perfectly capable
 * browser in several everyday situations that have nothing to do with browser support:
 *
 *   - the page is not a secure context (plain `http://` on anything but localhost);
 *   - a content/script blocker or privacy extension stopped one of our own scripts;
 *   - site data is blocked for this origin, so nothing may be stored;
 *   - the service worker that supplies the COOP/COEP headers on a static host has not taken
 *     control *yet* (every first visit passes through this state — §2.2.6), or was prevented
 *     from starting at all (private window, extension, stripped headers).
 *
 * Only once all of those are ruled out is "this browser can't run Gubbins" the honest answer.
 * This module gathers the signals that separate those cases and reduces them to one
 * {@link SupportCause}, so the boot screen can give guidance the user can act on instead of a
 * catch-all "Browser not supported".
 *
 * {@link diagnoseSupport} is pure — every environment probe is confined to
 * {@link collectSupportSignals} — so the decision table is exhaustively unit-testable.
 */
import { hasCrossOriginIsolation, hasOpfs, hasSharedArrayBuffer } from './feature-detection';

/**
 * Global set by `public/coi-bootstrap.js` as its very first statement — before any of its own
 * early returns — so its presence means exactly "that script executed", nothing more.
 *
 * It is the one signal that distinguishes a *blocked* script from a merely inert one: the
 * bootstrap is a same-origin `<script src>` in `<head>`, so by the time app code runs it must
 * have executed. If the app is running and this global is absent, something between the server
 * and the parser removed it — a content blocker, privacy extension, or filtering proxy.
 *
 * The name is duplicated in `public/coi-bootstrap.js`, which is a plain static asset and so
 * cannot import this constant. Keep the two in step — `support-diagnosis.test.ts` asserts it.
 */
export const COI_BOOTSTRAP_MARKER = '__gubbinsCoiBootstrapRan';

/**
 * How long to wait for a service-worker registration to become active before concluding that
 * one is never going to (§2.2.6). This is not a guess at install time so much as a race with
 * our own registration: the only `register()` call lives in `PwaUpdatePrompt`, which mounts
 * alongside the boot gate, so on a first visit the worker legitimately does not exist yet at
 * the moment we probe. Waiting costs nothing on a healthy boot (this code only ever runs once
 * support has already failed) and buys a correct answer instead of a premature one.
 *
 * @internal Exported for unit tests only.
 */
export const SERVICE_WORKER_PROBE_TIMEOUT_MS = 3_000;

/** The raw environment readings {@link diagnoseSupport} decides from. */
export interface SupportSignals {
  /** COOP/COEP are in force on this document, so `SharedArrayBuffer` is permitted (§2.2.6). */
  readonly crossOriginIsolated: boolean;
  /** `SharedArrayBuffer` exists — required by the synchronous SQLite OPFS VFS. */
  readonly sharedArrayBuffer: boolean;
  /** The Origin Private File System is reachable — the primary VFS (§2.2.1). */
  readonly opfs: boolean;
  /** A secure context (`https://`, or `localhost`/`127.0.0.1` over plain http). */
  readonly secureContext: boolean;
  /** `public/coi-bootstrap.js` executed — see {@link COI_BOOTSTRAP_MARKER}. */
  readonly coiBootstrapRan: boolean;
  /** `localStorage` can be read — throws outright when site data is blocked for this origin. */
  readonly localStorageUsable: boolean;
  /** `navigator.cookieEnabled` — false under a blanket "block all cookies" setting. */
  readonly cookiesEnabled: boolean;
  /** The Service Worker API is exposed at all (absent in a Firefox private window). */
  readonly serviceWorkerApi: boolean;
  /** A registration for our scope reached `active` within {@link SERVICE_WORKER_PROBE_TIMEOUT_MS}. */
  readonly serviceWorkerActive: boolean;
  /** A worker is controlling *this* document, so its injected headers apply to this navigation. */
  readonly serviceWorkerControlling: boolean;
}

/**
 * The single most likely root cause, in the order the boot screen should raise it. Every value
 * except `browser-unsupported` means the browser is fine and the *environment* is the problem.
 */
export type SupportCause =
  /** Served over plain `http://` from somewhere that is not localhost — no storage is granted. */
  | 'insecure-context'
  /** Our own same-origin script was stripped — a content blocker or filtering proxy. */
  | 'scripts-blocked'
  /** Cookies/site data are blocked for this origin, so nothing may be stored locally. */
  | 'site-data-blocked'
  /** The header-injecting service worker is starting up; this resolves itself (first visit). */
  | 'isolation-pending'
  /** The service worker cannot start, or its headers are being stripped before they arrive. */
  | 'isolation-blocked'
  /** Everything else checks out: the browser genuinely lacks what Gubbins needs. */
  | 'browser-unsupported';

export interface SupportDiagnosis {
  readonly cause: SupportCause;
  /** The human-readable capabilities `checkCriticalSupport` found missing. */
  readonly missing: readonly string[];
  /** Every reading behind {@link cause} — surfaced verbatim for bug reports. */
  readonly signals: SupportSignals;
}

/**
 * Reduce the signals to the one cause worth telling the user about.
 *
 * Order is the whole design: each check rules out a *precondition* of the checks below it, so the
 * first match is the root cause rather than a downstream symptom. An insecure context, for
 * instance, withholds all three critical capabilities at once — reporting "OPFS missing" there
 * would be true and useless.
 *
 * Only meaningful once `checkCriticalSupport` has already failed; with everything present it
 * falls through to `browser-unsupported`, which the caller would never ask about.
 */
export function diagnoseSupport(signals: SupportSignals): SupportCause {
  // Nothing below can hold without a secure context: it alone gates OPFS, service workers and
  // `SharedArrayBuffer`, so every other signal would merely echo it.
  if (!signals.secureContext) return 'insecure-context';

  // Our bootstrap script is same-origin and synchronous — if app code is running and it is not,
  // scripts are being filtered, and any further reading here is downstream of that.
  if (!signals.coiBootstrapRan) return 'scripts-blocked';

  // Blocked site data disables the service worker *and* the storage the database needs, so it
  // must be ruled out before blaming the worker for not starting.
  if (!signals.localStorageUsable || !signals.cookiesEnabled) return 'site-data-blocked';

  // Isolation is supplied by our service worker on static hosts (§2.2.6), so a failure here is
  // about the worker, not the browser — unless the worker is demonstrably doing its job.
  if (!signals.crossOriginIsolated || !signals.sharedArrayBuffer) {
    if (!signals.serviceWorkerApi || !signals.serviceWorkerActive) return 'isolation-blocked';
    // Active but not yet controlling this document: its headers apply from the next navigation,
    // which coi-bootstrap.js triggers on `controllerchange`. Transient, and self-resolving.
    // Already controlling yet still not isolated means the headers it sets are being removed
    // in transit — the one case where an active worker still cannot deliver isolation.
    return signals.serviceWorkerControlling ? 'isolation-blocked' : 'isolation-pending';
  }

  // Isolated, permitted to store, nothing blocked — the capability really is absent.
  return 'browser-unsupported';
}

/** The throwaway key the storage probe writes; removed again immediately. */
const STORAGE_PROBE_KEY = 'gubbins-support-probe';

/**
 * True when `localStorage` can actually be *written*, which is what Gubbins needs of it.
 *
 * A read alone is too weak a test: a blocked origin usually throws on the property access, but
 * some modes hand back a store that reads fine and only throws once written to. Since the probe
 * removes its own key, a pass leaves nothing behind.
 */
function canUseLocalStorage(): boolean {
  try {
    globalThis.localStorage.setItem(STORAGE_PROBE_KEY, '1');
    globalThis.localStorage.removeItem(STORAGE_PROBE_KEY);
    return true;
  } catch {
    // Covers both a blocked origin (SecurityError/QuotaExceededError) and no localStorage at all.
    return false;
  }
}

/**
 * Wait for a service worker to reach `active`, giving up after {@link SERVICE_WORKER_PROBE_TIMEOUT_MS}.
 *
 * `navigator.serviceWorker.ready` never rejects — it simply never settles when no registration
 * ever arrives — so the timeout is what turns "not yet" into a decidable "no".
 */
async function probeServiceWorkerActive(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SERVICE_WORKER_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    // The loser of the race is still pending; drop its timer rather than leave one armed for
    // seconds after the answer is known.
    clearTimeout(timer);
  }
}

/**
 * Read every signal from the live environment (the only impure step).
 *
 * @internal Exported for unit tests only.
 */
export async function collectSupportSignals(): Promise<SupportSignals> {
  const serviceWorkerApi = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const serviceWorkerActive = serviceWorkerApi ? await probeServiceWorkerActive() : false;

  return {
    crossOriginIsolated: hasCrossOriginIsolation(),
    sharedArrayBuffer: hasSharedArrayBuffer(),
    opfs: hasOpfs(),
    secureContext: typeof globalThis !== 'undefined' && globalThis.isSecureContext === true,
    coiBootstrapRan: (globalThis as Record<string, unknown>)[COI_BOOTSTRAP_MARKER] === true,
    localStorageUsable: canUseLocalStorage(),
    cookiesEnabled: typeof navigator === 'undefined' || navigator.cookieEnabled !== false,
    serviceWorkerApi,
    serviceWorkerActive,
    // Read *after* the probe: a worker that activated while we waited may have taken control.
    serviceWorkerControlling: serviceWorkerApi && navigator.serviceWorker.controller != null,
  };
}

/**
 * Collect the environment and reduce it to the diagnosis the boot screen renders.
 *
 * Takes `missing` from the caller's own `checkCriticalSupport()` rather than re-running it: this
 * probe can wait seconds on the service worker, and the report should show the reading that
 * actually sent the user here, not a second one taken after the fact.
 */
export async function diagnoseCriticalSupport(missing: readonly string[]): Promise<SupportDiagnosis> {
  const signals = await collectSupportSignals();
  return { cause: diagnoseSupport(signals), missing, signals };
}
