/**
 * The seam a screen uses to put its **main content first** on the one database connection
 * (issue #1575), sibling to {@link useInViewport} — which gates work on whether a panel is on
 * screen, where this gates it on whether the content the reader is waiting for has arrived.
 *
 * Every read in the app crosses one worker bridge, and the worker runs one statement at a time
 * (spec §2.2.4). A screen that mounts a dozen hooks at once therefore *orders* them by accident:
 * the filter-chip counts, the facet options and the alert badge are posted in render order, and
 * the list of items — the thing the reader opened the screen for — waits behind whichever of
 * them happened to subscribe first. On a large catalogue that is the difference between a list
 * in a second and an empty screen for a quarter of a minute.
 *
 * So a screen wraps itself in {@link PrimaryContentProvider}, saying whether its main read has
 * settled, and everything around that read — its own refinement controls and the chrome the
 * screen hosts — asks {@link useAfterPrimaryContent} before fetching.
 *
 * Two details make it honest rather than a race:
 *
 *  - **It opens one commit late.** Arriving data usually mounts more of the main content, and
 *    that content's own reads are posted in the same commit. Opening in an effect lets those
 *    reads reach the worker first, whatever order the components sit in — the grouped list's
 *    sections and the item cards' custom-field values are both this shape.
 *  - **It is latched, per `scope`.** Once open it stays open, so a deferred read is never
 *    switched off again and re-fetched for having gone stale while it was. A caller whose read
 *    is keyed by something the main read is also keyed by — the selected location — passes that
 *    as its `scope`, and then a change of location waits for the list again, exactly as the
 *    first open did, because the read is a different read.
 *
 * A screen that declares nothing defers nothing: with no provider above it the hook answers
 * `true` from the first render, so every other screen behaves as it did.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** `null` means no screen above has declared any primary content — so nothing waits. */
const PrimaryContentContext = createContext<boolean | null>(null);

/**
 * What a deferred read may be scoped by — the axis its own query key shares with the screen's
 * main read, which in practice is a selected id.
 *
 * Deliberately a primitive rather than `unknown`: scopes are compared by identity, so an object
 * or array rebuilt each render would never match the latched one, leaving the read shut forever
 * and re-running the effect on every render.
 */
export type ReadScope = string | number | boolean | null;

export interface PrimaryContentProviderProps {
  /**
   * Whether the screen's main read has settled — resolved *or* failed, and for the filters
   * currently on screen. `query.isFetched` is the flag that says so (it is per query key, so a
   * new filter reads as unsettled again while its own first page loads).
   */
  readonly settled: boolean;
  readonly children: ReactNode;
}

/** Declare the screen's main content, so the reads around it can wait for it. */
export function PrimaryContentProvider({ settled, children }: PrimaryContentProviderProps) {
  return <PrimaryContentContext.Provider value={settled}>{children}</PrimaryContentContext.Provider>;
}

/**
 * Whether a deferred read may start: `true` one commit after `settled` first held for `scope`,
 * and for as long as `scope` stays the same.
 *
 * For a screen's *own* hooks, which sit above its {@link PrimaryContentProvider} and so cannot
 * read the context; everything under the provider uses {@link useAfterPrimaryContent} instead.
 */
export function useAfterSettled(settled: boolean, scope: ReadScope = null): boolean {
  // The scope the gate is open for, boxed so that "open for `null`" is distinguishable from
  // "not open" — a screen with no scope of its own passes `null` as its scope.
  const [openFor, setOpenFor] = useState<{ readonly scope: ReadScope } | null>(null);
  const open = openFor !== null && Object.is(openFor.scope, scope);

  useEffect(() => {
    if (settled && !open) setOpenFor({ scope });
  }, [settled, open, scope]);

  return open;
}

/**
 * Whether a read that belongs *around* the screen's main content may start yet — the filter
 * counts, the facet dictionaries, the navigation's alert badge.
 *
 * Pass a `scope` when the read is keyed by the same thing the main read is scoped to (the
 * selected location), so that changing it makes this read wait for the list again rather than
 * racing it. Leave it out for a read the main content's filters do not touch.
 */
export function useAfterPrimaryContent(scope: ReadScope = null): boolean {
  const settled = useContext(PrimaryContentContext);
  // Called unconditionally (rules of hooks), and passed `false` where no screen declared any
  // primary content: the answer below is `true` regardless there, and an unsettled gate never
  // latches, so a screen outside this seam is not re-rendered by a gate it does not use.
  const open = useAfterSettled(settled ?? false, scope);
  return settled === null ? true : open;
}

/**
 * The same, one step further back in the queue: for **chrome that is not about this screen at
 * all** — the navigation's alert badge, which reads the whole vault to count things the reader
 * did not open this screen to see.
 *
 * It opens a commit after {@link useAfterPrimaryContent} does, and the screen's own refinements
 * are posted in exactly that commit, so they reach the worker first. Without the extra step the
 * order inside the queue would be decided by where each component happens to sit in the tree,
 * which put five whole-vault feeds ahead of the chip counts belonging to the list beside them.
 *
 * Takes no scope: chrome is not scoped to a screen's filters. A read that *is* scoped by them
 * belongs to the screen rather than to the chrome around it, and waits one step earlier.
 */
export function useAfterScreenReads(): boolean {
  const settled = useContext(PrimaryContentContext);
  const afterContent = useAfterSettled(settled ?? false);
  // The second step applies only where a screen actually declared its content. Chaining it
  // unconditionally would hold the chrome on *every* other screen back by a commit — and, worse,
  // make "nothing has been read yet" a state each of those screens passes through, which some
  // readers of a feed treat as an answer.
  const afterScreenReads = useAfterSettled(settled !== null && afterContent);
  return settled === null ? true : afterScreenReads;
}
