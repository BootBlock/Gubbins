/**
 * Keeping the bridge alive (issue #305).
 *
 * Everything *inside* the request path is already guarded — `handleRequest` wraps routing in a
 * try/catch that always answers a generic 500. This module covers everything *outside* it, where
 * an unhandled failure does not produce an error response but terminates the process:
 *
 * - a post-startup `'error'` event on the HTTP server (`EMFILE`/`ENFILE` on accept, a transient
 *   bind failure). The listen promise attaches a *one-shot* listener, which is consumed the moment
 *   it fires and never re-armed, so without this the server runs its whole life with no `'error'`
 *   listener and Node re-throws the next one;
 * - a malformed request line or oversized headers (`'clientError'`), which any port scanner will
 *   produce;
 * - a rejection escaping a fire-and-forget path (the MQTT publisher, the SSE hub, the watcher).
 *   Since Node 15 an unhandled rejection terminates the process by default.
 *
 * The bridge serves a snapshot it can always re-hydrate from disk, so surviving one of these and
 * logging it is strictly better for the user than a Home Assistant integration that goes dead
 * until someone notices. Surviving *indefinitely* is not, though: a fault that repeats in a tight
 * loop means the process is in a state it cannot reason about, and the honest response is to exit
 * and let the supervisor (systemd, Docker, the HA add-on) restart it cleanly. `createFaultTracker`
 * is that judgement, kept pure so it can be tested without crashing a test runner.
 */
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

/** Faults tolerated inside {@link FAULT_WINDOW_MS} before the process gives up and restarts. */
export const FAULT_THRESHOLD = 10;
/** Sliding window over which {@link FAULT_THRESHOLD} is counted. */
export const FAULT_WINDOW_MS = 60_000;

export type FaultVerdict = 'continue' | 'exit';

export interface FaultTracker {
  /** Record a fault at `now` (epoch ms) and decide whether the process can carry on. */
  record(now: number): FaultVerdict;
}

export interface FaultTrackerOptions {
  readonly threshold?: number;
  readonly windowMs?: number;
}

/**
 * Count faults over a sliding window: `'continue'` while they are occasional, `'exit'` once
 * `threshold` of them land within `windowMs` of each other.
 *
 * Pure apart from the caller-supplied clock — the window is derived from the timestamps passed in,
 * never from `Date.now()`, so the storm behaviour is unit-testable.
 */
export function createFaultTracker(options: FaultTrackerOptions = {}): FaultTracker {
  const threshold = options.threshold ?? FAULT_THRESHOLD;
  const windowMs = options.windowMs ?? FAULT_WINDOW_MS;
  let recent: number[] = [];
  return {
    record(now) {
      // Drop anything that has aged out, then judge what is left (including this fault). Only the
      // most recent `threshold` timestamps can ever change the verdict, so older ones are dropped
      // too — otherwise a storm under a caller-supplied `onExit` that does not terminate would
      // accumulate one entry per fault for the whole window.
      recent = recent.filter((at) => now - at < windowMs).slice(-(threshold - 1));
      recent.push(now);
      return recent.length >= threshold ? 'exit' : 'continue';
    },
  };
}

/** Message for a thrown value that may not be an `Error` (a rejection can carry anything). */
export function faultMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === undefined ? err.message : `${err.message} (${code})`;
  }
  return String(err);
}

/**
 * Re-arm a **persistent** `'error'` listener on a listening server, plus a `'clientError'` handler.
 *
 * Call this *after* `listen` has resolved: before that, the one-shot listener that rejects the
 * listen promise owns the event (a failed bind must fail startup, not be logged and shrugged off).
 * From here on the server is bound and an error is a runtime hiccup on an individual accept —
 * losing that connection is acceptable, losing the whole bridge is not.
 */
export function attachServerResilience(server: Server, tracker: FaultTracker, onExit: () => void): void {
  server.on('error', (err) => {
    console.error(`Bridge server error (the bridge is still serving): ${faultMessage(err)}`);
    if (tracker.record(Date.now()) === 'exit') onExit();
  });

  // A malformed request line or oversized headers. Routine background noise on any exposed port,
  // so it is answered rather than logged — attaching this listener replaces Node's default
  // response, so it has to do the default's job: a terse reply when the socket can still take one,
  // and a destroy when it cannot. Not counted as a fault; a port scanner must not restart us.
  server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const status =
      err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  });
}

/** Wrap a callback so it runs at most once, however many times it is invoked. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

export interface ProcessResilienceOptions {
  readonly tracker?: FaultTracker;
  /** Invoked when the fault rate says the process should restart. Defaults to `process.exit(1)`. */
  readonly onExit?: () => void;
}

export interface ProcessResilience {
  readonly tracker: FaultTracker;
  readonly onExit: () => void;
}

/**
 * Install the process-level last resort: an uncaught exception or an unhandled rejection is logged
 * and survived rather than terminating the bridge, unless they are arriving fast enough to mean the
 * process is stuck (see {@link createFaultTracker}).
 *
 * These are process-global, so install them **once** per process — the caller is responsible for
 * that (`serve.ts` memoises it), because registering a second pair would log and count every fault
 * twice.
 */
export function installProcessResilience(options: ProcessResilienceOptions = {}): ProcessResilience {
  const tracker = options.tracker ?? createFaultTracker();
  // Latched: once the window is full every *subsequent* fault also reports `'exit'` (the aged-in
  // faults are still there), and a caller whose `onExit` shuts down gracefully rather than calling
  // `process.exit` must not have that shutdown re-entered while it is still running.
  const onExit = once(
    options.onExit ??
      ((): void => {
        console.error(
          `Bridge exiting after ${FAULT_THRESHOLD} faults in ${FAULT_WINDOW_MS / 1000}s — restart it ` +
            'to recover (your service manager will do this automatically).',
        );
        process.exit(1);
      }),
  );

  process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception (the bridge is still serving): ${faultMessage(err)}`);
    if (tracker.record(Date.now()) === 'exit') onExit();
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`Unhandled promise rejection (the bridge is still serving): ${faultMessage(reason)}`);
    if (tracker.record(Date.now()) === 'exit') onExit();
  });

  return { tracker, onExit };
}
