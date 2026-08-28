/**
 * Make an open dialog a **history entry**, so the system Back gesture closes it (issue #590).
 *
 * Gubbins installs as a `display: standalone` PWA, which means an installed instance has no
 * browser chrome: the system Back button / edge swipe is the *only* back affordance there is.
 * Nothing in the app used to touch history, so while a dialog was open Back did whatever it
 * would have done anyway — popped the route out from under the dialog, or, at the first entry,
 * closed the app. Either way the dialog's uncommitted contents went with it, and Back is the
 * gesture everyone reaches for to dismiss something full-screen.
 *
 * The treatment is the usual one: push a state on open, dismiss on `popstate`, and hand the
 * entry back when the surface is closed by any other route (Close, Escape, backdrop, a
 * successful submit) so the stack stays balanced. Wired once into `use-dialog-behaviour`, it
 * covers {@link Modal}, {@link RailModal} and {@link Drawer}; the two full-screen camera
 * surfaces, which predate that seam and hand-roll their own, opt in by calling the hook.
 *
 * ## What makes this fiddly
 *
 * - **A dismissal can be refused or absorbed.** `Modal` turns Escape down while work is in
 *   flight, raises a question first when an editor below it holds a draft, and the command
 *   palette backs out of its quick-actions panel before it closes at all. The entry is spent
 *   either way, so the hook pushes its replacement *before* telling the surface — otherwise a
 *   dismissal that answers by opening something new ends up underneath it in the stack.
 * - **Dialogs nest, and a stack can unwind all at once.** Closing a parent unmounts its child in
 *   the same commit, so two releases land in one tick. `history.back()` twice in a tick is not
 *   reliably two steps, so releases are batched into a single `history.go(-n)`.
 * - **Our entry can end up buried.** A router navigation made from inside a dialog pushes on top
 *   of it, and popping then would undo that navigation rather than the dialog. So a release only
 *   reclaims the entry while it is verifiably still the one the browser is sitting on; otherwise
 *   it is abandoned in place, costing at worst one later Back press that changes nothing.
 *
 * The ordering logic is in the pure {@link resolveDismissals}, split out so the LIFO rules are
 * unit-testable without a session history (the `modal-stack.ts` seam pattern).
 */
import { useEffect, useRef } from 'react';

/**
 * The key our marker lives under inside a history entry's `state`. Namespaced because the state
 * object is shared: the router keeps its own index and key in there, and we spread those through
 * so our entry is indistinguishable from its neighbour as far as the router is concerned.
 */
const STATE_KEY = '__gubbinsDialog';

/** One open surface holding a history entry. `id` is what identifies it in `history.state`. */
export interface DialogHistoryEntry {
  readonly id: string;
  /** Monotonic push order, so a batch of releases can be put back into stack order. */
  readonly seq: number;
  readonly onDismiss: () => void;
}

/**
 * Which registered entries a `popstate` has just discarded, and in what order to tell them.
 *
 * The registry is LIFO and mirrors the top of the session history, so arriving at `arrivedId`
 * means every entry stacked *above* it is gone. They are dismissed topmost-first, which is the
 * order the user would have closed them by hand. An `arrivedId` naming nothing in the registry —
 * `null` for an ordinary route entry, or a marker whose surface has already gone — discards the
 * lot.
 *
 * @param entries The open surfaces, oldest first.
 * @param arrivedId The `__gubbinsDialog` marker on the entry the browser has landed on.
 */
export function resolveDismissals<T extends { readonly id: string }>(
  entries: readonly T[],
  arrivedId: string | null,
): { readonly remaining: readonly T[]; readonly dismissed: readonly T[] } {
  const index = arrivedId === null ? -1 : entries.findIndex((e) => e.id === arrivedId);
  return {
    remaining: entries.slice(0, index + 1),
    dismissed: entries.slice(index + 1).reverse(),
  };
}

let entries: DialogHistoryEntry[] = [];
let counter = 0;
/** Entries released this tick — flushed together as one `history.go(-n)`. */
let queuedReleases: DialogHistoryEntry[] = [];
let flushScheduled = false;
/** Set while a pop *we* asked for is in flight, so it is not read as the user pressing Back. */
let ignoreNextPop = false;
let listening = false;

/**
 * Start listening, once, and never stop.
 *
 * Detaching whenever the last dialog closed looked tidy and was a bug: closing one by its ✕ asks
 * the browser for a pop, and the handler that clears {@link ignoreNextPop} has to still be there
 * when that pop lands. Unhooked first, the flag stayed set and the *next* dialog's first Back
 * press was swallowed. The listener also does the skipping over abandoned entries, which is work
 * that outlives any single dialog.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('popstate', onPopState);
}

/** The `__gubbinsDialog` marker on the entry the browser is currently sitting on, if any. */
function currentEntryId(): string | null {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null) return null;
  const id: unknown = (state as Record<string, unknown>)[STATE_KEY];
  return typeof id === 'string' ? id : null;
}

function onPopState(): void {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return;
  }
  const arrivedId = currentEntryId();
  const { remaining, dismissed } = resolveDismissals(entries, arrivedId);
  entries = [...remaining];
  for (const entry of dismissed) entry.onDismiss();
  // Landing on an abandoned marker — one whose surface has already gone — is deliberately left
  // alone. Stepping over it with another `history.back()` looks like a kindness and is a trap: a
  // dismissal above pushes its replacement synchronously, so by the time we got here the browser
  // would no longer be on the dead entry, and going back would land on it *again*, dismiss the
  // replacement, push another, and never stop. The cost of leaving it is one Back press that
  // changes nothing visible, in the rare case where an entry was stranded (see
  // {@link releaseDialogHistoryEntry}) and nothing is open above it. A press that arrives while
  // something *is* still open is not wasted at all — it dismisses it, above.
}

function flushReleases(): void {
  flushScheduled = false;
  // Sorted back into stack order rather than release order: a parent torn down before the child
  // it opened releases bottom-up, and it is still one contiguous run of entries to reclaim.
  const released = queuedReleases.sort((a, b) => b.seq - a.seq);
  queuedReleases = [];
  const topmost = released[0];
  if (!topmost) return;
  // Reclaim only a contiguous run sitting at the very top of the stack: the topmost released
  // entry must still be the one the browser is on, and nothing left open may sit above the run.
  // Anything else means something was pushed over them since — a route navigation made from
  // inside the dialog — and going back would undo *that* instead.
  if (currentEntryId() !== topmost.id) return;
  const lowest = released[released.length - 1]!;
  if (entries.some((e) => e.seq > lowest.seq)) return;
  ignoreNextPop = true;
  window.history.go(-released.length);
}

/**
 * Register an open surface and give the browser an entry for Back to consume.
 *
 * The current `history.state` is spread through so the router's own index and key survive: our
 * entry then reads as the same location it was pushed from, and the eventual pop resolves to no
 * navigation rather than a bogus one.
 */
export function pushDialogHistoryEntry(onDismiss: () => void): DialogHistoryEntry {
  const seq = ++counter;
  const entry: DialogHistoryEntry = { id: `dialog-${seq}`, seq, onDismiss };
  listen();
  entries.push(entry);
  const state: unknown = window.history.state;
  const base = typeof state === 'object' && state !== null ? state : {};
  const next = { ...base, [STATE_KEY]: entry.id };
  // Take over an entry released moments ago rather than stacking a second one on top of it. Two
  // surfaces changing hands inside one tick is ordinary — a dialog closing as the next opens —
  // and in development React's StrictMode does it to *every* dialog by design, mounting each
  // effect twice. Left to push, the first entry would be stranded below the live one — a dead
  // entry the pop handler then has to step over, which costs the user a Back press that arrives
  // nowhere. Only the entry the browser is actually sitting on can be reused, so this cannot
  // swallow one that is still someone else's.
  const reusable = queuedReleases.findIndex((released) => released.id === currentEntryId());
  if (reusable >= 0) {
    queuedReleases.splice(reusable, 1);
    window.history.replaceState(next, '');
  } else {
    window.history.pushState(next, '');
  }
  return entry;
}

/**
 * Deregister a surface closed by something other than Back, handing its entry back to the
 * browser so the stack stays balanced.
 *
 * A no-op for an entry a `popstate` already consumed — that is the ordinary case of the user
 * pressing Back, where the browser has taken the entry itself. An entry {@link flushReleases}
 * declines to reclaim is abandoned in place: nothing can remove an entry from the middle of a
 * session history, and an inert one carrying the same URL as its neighbour is the mildest
 * possible outcome.
 */
export function releaseDialogHistoryEntry(entry: DialogHistoryEntry): void {
  const index = entries.indexOf(entry);
  if (index < 0) return;
  entries.splice(index, 1);
  queuedReleases.push(entry);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushReleases);
}

/** How many surfaces currently hold a history entry. @internal Exported for tests. */
export function openDialogHistoryCount(): number {
  return entries.length;
}

/**
 * Hold a history entry for as long as `open` is true, calling `onDismiss` when Back consumes it.
 *
 * `onDismiss` is read through a ref so a call site can keep passing an inline closure without
 * re-running the effect — which would otherwise push a second entry on every render. It is the
 * surface's ordinary close request, not a bypass: a `Modal` passes the same `requestClose` its ✕
 * uses, so Back is refused while work is in flight and asks before discarding a draft, exactly
 * as every other route out does.
 *
 * **The replacement entry is pushed before the surface is told, not after.** A dismissal need not
 * close anything — it can be refused outright, or *answered* by opening something new, which is
 * what a dirty dialog does when it raises "Discard unsaved changes?". Re-pushing afterwards, from
 * an effect, puts this surface's entry above the question's: React runs a child's effects before
 * its parent's, so the question registers first and every later Back then resolves to the dialog
 * underneath and re-asks a question already on screen — Back stops working entirely, with no way
 * out on a device where it is the only back affordance. Pushing first keeps the stack in the order
 * the surfaces are actually in. When the dismissal *does* close the surface, unmounting releases
 * the replacement straight away and the stack ends up level.
 */
export function useDialogHistoryEntry(open: boolean, onDismiss: () => void): void {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const entryRef = useRef<DialogHistoryEntry | null>(null);

  useEffect(() => {
    if (!open) return;
    const register = (): void => {
      entryRef.current = pushDialogHistoryEntry(() => {
        register();
        onDismissRef.current();
      });
    };
    register();
    return () => {
      if (entryRef.current) releaseDialogHistoryEntry(entryRef.current);
      entryRef.current = null;
    };
  }, [open]);
}
