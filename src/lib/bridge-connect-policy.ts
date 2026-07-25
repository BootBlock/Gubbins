/**
 * Telling the service worker which bridge origin to allow through the CSP (issue #385).
 *
 * The app fetches the bridge at an address only the user knows, and `connect-src` must name it
 * or the browser blocks the call before it leaves the page. `src/csp.ts` explains why the
 * *worker* is the only place that can add it; this module is the thin seam either side of that:
 * the page registers the origin, the worker stores it, and the page can ask whether the policy
 * the document is **already** enforcing covers it — because a policy is fixed at load, so a
 * newly-entered bridge needs one reload before it takes effect.
 *
 * Deliberately free of React and of any import the service worker cannot take (it imports
 * {@link BRIDGE_ORIGIN_MESSAGE} from here). The DOM is touched only inside function bodies, all
 * of them guarded, so this is safe to import from a worker and from a test with no `document`.
 */
// Relative, not aliased: the service worker imports this module, and its bundle is built
// outside the app's alias-resolving graph.
import { policyAllowsConnectOrigin } from '../csp';

/**
 * The `postMessage` type the page sends the worker: `{ type, origin }`, where `origin` is a
 * bridge base URL (or `''`/`null` to clear it). Named in the same style as the `SKIP_WAITING`
 * handshake workbox-window owns — and deliberately *not* `gubbins:`-prefixed, which is the
 * reserved namespace for persisted storage keys (`lib/storage-keys.ts`), not for messages.
 */
export const BRIDGE_ORIGIN_MESSAGE = 'SET_BRIDGE_ORIGIN';

/** How long to wait for the worker before giving up and letting the caller carry on. */
const REGISTER_TIMEOUT_MS = 2_000;

/**
 * The CSP the current document is enforcing via its `<meta>`, or `null` when there is none.
 *
 * `null` is the honest answer for the dev server, which injects no meta and enforces no policy
 * (the meta plugin is `apply: 'build'`). Only the meta is readable from script — a response
 * header is not — but the two forms are built from the same source, and the meta is the one
 * that vetoes a worker-computed header anyway, so it is the form worth reading.
 */
export function readDocumentPolicy(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return meta?.getAttribute('content') ?? null;
}

/**
 * Can this document already reach `origin`? Reads the delivered policy and the app's own origin,
 * so a bridge hosted on the app's own origin (`'self'`) needs no allowance at all.
 */
export function documentAllowsBridgeOrigin(origin: string): boolean {
  const selfOrigin = typeof location === 'undefined' ? null : location.origin;
  return policyAllowsConnectOrigin(readDocumentPolicy(), origin, selfOrigin);
}

/** Is a service worker in control of this page — i.e. is there anything able to widen the policy? */
export function hasServiceWorkerControl(): boolean {
  return typeof navigator !== 'undefined' && (navigator.serviceWorker?.controller ?? null) !== null;
}

/**
 * Hand the worker the origin to allow, resolving once it has **stored** it.
 *
 * The acknowledgement matters: the caller's next move is usually to reload, and reloading before
 * the worker has stored the origin would serve the old policy and ask for a second reload. A
 * `MessageChannel` reply is the only way to know that.
 *
 * The **whole** exchange is bounded, not just the reply. `navigator.serviceWorker.ready` never
 * settles while no registration has become active, so waiting on it alone could leave a caller —
 * and the reload button that awaits this — hanging indefinitely on a browser where the worker
 * never registers. Giving up and letting the caller carry on is always safe: the worst case is
 * the reload it was about to do anyway, which changes nothing.
 *
 * A no-op where service workers are unavailable at all.
 */
export async function registerBridgeOrigin(origin: string | null): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) return;
  await Promise.race([
    deliverBridgeOrigin(origin).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, REGISTER_TIMEOUT_MS)),
  ]);
}

/** Post the origin to the active worker and resolve on its reply. */
async function deliverBridgeOrigin(origin: string | null): Promise<void> {
  const worker = (await navigator.serviceWorker.ready).active;
  if (worker === null) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    worker.postMessage({ type: BRIDGE_ORIGIN_MESSAGE, origin }, [channel.port2]);
  });
}
