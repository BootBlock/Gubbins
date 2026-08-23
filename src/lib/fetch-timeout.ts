/**
 * Deadlines for the app's own network requests — the one place a `fetch` timeout is chosen
 * (issue #632), in the same spirit as `lib/bridge-url` for a bridge address.
 *
 * `fetch` has **no default response timeout** in a browser. A peer that completes the TCP
 * handshake and then sends nothing back leaves the promise pending for as long as the socket
 * survives, which is the ordinary mobile failure rather than an exotic one: a handset moving from
 * Wi-Fi to cellular orphans the socket, and a bridge on a host that has gone to sleep answers the
 * connect and nothing else. Every one of the app's transports guards its call with an in-flight
 * flag cleared only when the promise settles, so a request that never settles does not merely
 * spin — the control stays disabled, with nothing on screen to explain it.
 *
 * The remedy is one deadline per request, chosen from {@link FETCH_TIMEOUT_MS} and merged into the
 * request's init by {@link withTimeout}. An expiry rejects the `fetch`, which lands in the
 * `catch` each transport already has, so a timeout reports itself in the failure vocabulary that
 * surface already speaks (`bridge-unreachable`, "couldn't reach the product database", `null`)
 * rather than adding a reason every caller would have to learn.
 */

/**
 * How long each kind of request may take, in milliseconds.
 *
 * The budgets differ because the requests do: a LAN bridge probe that answers in a few
 * milliseconds is not a snapshot upload over a phone's uplink, and one number generous enough for
 * the upload would leave the probe hanging for a minute. Each is a *ceiling on a stuck request*,
 * not a target — a healthy request finishes far inside it.
 *
 * The snapshot budgets are deliberately generous. Cutting a slow-but-progressing upload short
 * would be a worse bug than the one being fixed: the user loses a sync that was going to work,
 * and the app cannot tell that apart from a peer that has gone silent. Two minutes of a disabled
 * button is unpleasant; forever is what this exists to stop.
 */
export const FETCH_TIMEOUT_MS = {
  /** A cheap same-origin `HEAD` whose failure already degrades silently (the sync time source). */
  probe: 5_000,
  /** Reading the deployed build's `version.json` before the update banner decides what to say. */
  manifest: 10_000,
  /** A bridge call carrying no payload: the scale, the webhook log, the discovery index. */
  bridge: 10_000,
  /** A bridge call that uploads the whole snapshot, so it is bounded by the user's uplink. */
  bridgePush: 120_000,
  /** A third-party lookup provider on the open internet (matches the companion extension's 15s). */
  lookup: 15_000,
  /** A cloud-sync call that may move the whole snapshot in either direction. */
  cloud: 120_000,
} as const;

/** A named request budget, so a call site picks a documented one rather than a bare number. */
export type FetchTimeoutKind = keyof typeof FETCH_TIMEOUT_MS;

/**
 * An `AbortSignal` that aborts after `ms`, or `undefined` where the runtime has no
 * `AbortSignal.timeout` (a browser older than the app's baseline, or a bare test harness).
 *
 * Degrading to `undefined` rather than throwing keeps the absence of a deadline exactly as bad as
 * it is today — the request still runs — instead of turning it into a failure to make the request
 * at all.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(ms);
}

/**
 * Merge a deadline into a request init, leaving every other field untouched.
 *
 * Returns a new object so a caller's init is never mutated, and only sets `signal` when the
 * runtime can supply one — an explicit `signal: undefined` would override nothing but reads as
 * though a deadline were set.
 */
export function withTimeout<T extends object>(init: T, kind: FetchTimeoutKind): T & { signal?: AbortSignal } {
  const signal = timeoutSignal(FETCH_TIMEOUT_MS[kind]);
  return signal === undefined ? init : { ...init, signal };
}
