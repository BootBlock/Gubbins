/**
 * Tests for the Back-gesture seam (issue #590) — `dialog-history.ts`.
 *
 * Three layers, in order of how much they can pin down:
 *
 * 1. {@link resolveDismissals}, pure, where the LIFO ordering rules are stated outright.
 * 2. The registry against happy-dom's real session history, which is what actually shows that a
 *    Back press dismisses, that a Close hands the entry back rather than leaving it to swallow a
 *    later press, and that an unwinding stack of dialogs costs exactly one Back each.
 * 3. {@link Modal}, to hold the wiring: a dialog gets this from `use-dialog-behaviour` alone, and
 *    a Back press has to reach the *guarded* close — the one that refuses while work is in flight
 *    — not slip past it.
 */
import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import {
  openDialogHistoryCount,
  pushDialogHistoryEntry,
  releaseDialogHistoryEntry,
  resolveDismissals,
} from './dialog-history';
import { Modal } from './modal';
import { useReportUnsavedChanges } from './unsaved-changes';

/** The marker key `dialog-history.ts` writes into `history.state`. */
const STATE_KEY = '__gubbinsDialog';

const marker = (): unknown => (window.history.state as Record<string, unknown> | null)?.[STATE_KEY];

let sentinels = 0;
/**
 * Stand a known, marker-free entry under whatever the test opens next, and return it.
 *
 * `history.length` cannot answer whether an entry was handed back — going back leaves the
 * forward entries in place — so balance is asserted by *where the browser ends up*: exactly on
 * this entry means one dialog entry was reclaimed, not none and not two.
 */
function baseEntry(): { readonly page: number } {
  const state = { page: ++sentinels };
  window.history.pushState(state, '');
  return state;
}

/** Press Back and wait for the browser to finish the traversal. */
async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Let a queued release flush (a microtask) and the traversal it asks for complete. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  cleanup();
  await settle();
});

describe('resolveDismissals', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('discards every entry when the browser lands outside them', () => {
    const { remaining, dismissed } = resolveDismissals(entries, null);
    expect(remaining).toEqual([]);
    expect(dismissed.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps the arrived entry and everything below it', () => {
    const { remaining, dismissed } = resolveDismissals(entries, 'a');
    expect(remaining.map((e) => e.id)).toEqual(['a']);
    expect(dismissed.map((e) => e.id)).toEqual(['c', 'b']);
  });

  it('dismisses topmost-first, so a stack unwinds the way it was built', () => {
    const { dismissed } = resolveDismissals(entries, 'b');
    expect(dismissed.map((e) => e.id)).toEqual(['c']);
  });

  it('treats a marker naming no open surface as landing outside them', () => {
    const { remaining, dismissed } = resolveDismissals(entries, 'gone');
    expect(remaining).toEqual([]);
    expect(dismissed).toHaveLength(3);
  });

  it('leaves an empty registry alone', () => {
    expect(resolveDismissals([], 'a')).toEqual({ remaining: [], dismissed: [] });
  });
});

describe('the history entry an open dialog holds', () => {
  it('gives Back something to consume, and dismisses when it is consumed', async () => {
    const onDismiss = vi.fn();
    pushDialogHistoryEntry(onDismiss);
    expect(marker()).toBeTypeOf('string');
    expect(openDialogHistoryCount()).toBe(1);

    await pressBack();

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(openDialogHistoryCount()).toBe(0);
    expect(marker()).toBeUndefined();
  });

  it('hands the entry back when the surface closes some other way', async () => {
    const base = baseEntry();
    const entry = pushDialogHistoryEntry(vi.fn());

    releaseDialogHistoryEntry(entry);
    await settle();

    // Back is once again the *page's*, not a spent dialog entry's: the browser is sitting
    // exactly where it was before the dialog opened.
    expect(window.history.state).toEqual(base);
    expect(openDialogHistoryCount()).toBe(0);
  });

  it('costs one Back press per nested dialog, innermost first', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    pushDialogHistoryEntry(outer);
    pushDialogHistoryEntry(inner);

    await pressBack();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(openDialogHistoryCount()).toBe(1);

    await pressBack();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(openDialogHistoryCount()).toBe(0);
  });

  it('reclaims a whole stack torn down in one commit, one step per dialog', async () => {
    const base = baseEntry();
    const parent = pushDialogHistoryEntry(vi.fn());
    const child = pushDialogHistoryEntry(vi.fn());

    // Closing a parent unmounts its child in the same commit, so both releases land in one tick.
    releaseDialogHistoryEntry(child);
    releaseDialogHistoryEntry(parent);
    await settle();

    // Landing on `base` is the whole point: one step short and Back would hit the parent's spent
    // entry and do nothing visible; one step long and it would undo a real navigation.
    expect(window.history.state).toEqual(base);
  });

  it('reclaims a stack released bottom-up just the same', async () => {
    const base = baseEntry();
    const parent = pushDialogHistoryEntry(vi.fn());
    const child = pushDialogHistoryEntry(vi.fn());

    releaseDialogHistoryEntry(parent);
    releaseDialogHistoryEntry(child);
    await settle();

    expect(window.history.state).toEqual(base);
  });

  it('still answers Back after a dialog closed by its own ✕', async () => {
    baseEntry();
    // Establish that Back works at all here, so the assertion below is about what the ✕ did and
    // not about whatever an earlier case left behind.
    const warmUp = vi.fn();
    pushDialogHistoryEntry(warmUp);
    await pressBack();
    expect(warmUp).toHaveBeenCalledTimes(1);

    // Reclaiming a dialog's entry asks the browser for a pop of our own. The pop that answers
    // must not be mistaken for the user pressing Back — nor left standing to swallow the press
    // that comes after it.
    releaseDialogHistoryEntry(pushDialogHistoryEntry(vi.fn()));
    await settle();

    const second = vi.fn();
    pushDialogHistoryEntry(second);
    await pressBack();

    expect(second).toHaveBeenCalledTimes(1);
  });

  it('takes over an entry released in the same tick instead of stacking on it', async () => {
    const base = baseEntry();
    const depth = window.history.length;

    // One surface handing over to another inside a tick — what React's StrictMode does to every
    // dialog in development, and what a dialog closing as the next opens does in production.
    releaseDialogHistoryEntry(pushDialogHistoryEntry(vi.fn()));
    const second = vi.fn();
    pushDialogHistoryEntry(second);
    await settle();

    // Counted, not merely inferred from behaviour: a stranded entry sits below a live one and
    // carries the same URL, so the surface still opens and closes exactly as it should. What it
    // costs shows up only later, and only in the depth of the stack.
    expect(window.history.length).toBe(depth + 1);

    await pressBack();
    expect(second).toHaveBeenCalledTimes(1);
    expect(window.history.state).toEqual(base);
  });

  it('does not double-pop an entry Back already took', async () => {
    const base = baseEntry();
    const entry = pushDialogHistoryEntry(vi.fn());
    await pressBack();
    expect(window.history.state).toEqual(base);

    // The surface unmounts in response, releasing an entry the browser has already reclaimed. A
    // second pop here would walk the user off the page that was underneath the dialog.
    releaseDialogHistoryEntry(entry);
    await settle();

    expect(window.history.state).toEqual(base);
  });
});

/** A dialog whose "work in flight" flag the test drives, mirroring a save or a restore. */
function BusyModalHarness({ busy }: { readonly busy: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Restore backup" busy={busy}>
      <p>Working…</p>
    </Modal>
  );
}

/** A dialog whose editor is holding a draft, so a dismissal raises the discard question. */
function DirtyModalHarness() {
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Edit item">
      <DirtyEditor />
    </Modal>
  );
}

function DirtyEditor() {
  useReportUnsavedChanges(true);
  return <p>Half-typed</p>;
}

describe('Modal — the Back gesture', () => {
  it('closes the dialog instead of navigating the screen behind it', async () => {
    render(<BusyModalHarness busy={false} />);
    await waitFor(() => expect(marker()).toBeTypeOf('string'));

    await pressBack();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is refused, and its entry replaced, while the dialog has work in flight', async () => {
    render(<BusyModalHarness busy />);
    await waitFor(() => expect(marker()).toBeTypeOf('string'));
    const first = marker();

    await pressBack();

    // Refused like Escape and the ✕ are — and a fresh entry is pushed, so the *next* Back is
    // still the dialog's rather than the router's.
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(marker()).toBeTypeOf('string'));
    expect(marker()).not.toBe(first);
  });

  it('reaches the discard question it raises, rather than trapping Back behind it', async () => {
    render(<DirtyModalHarness />);
    await waitFor(() => expect(marker()).toBeTypeOf('string'));

    await pressBack();
    // The dismissal was answered by opening a question, not by closing. The replacement entry
    // has to sit *under* that question's, or the next press resolves to this dialog again and
    // re-asks a question already on screen — with Back the only way out, that is a trap.
    expect(screen.getByTestId('unsaved-keep-editing')).toBeTruthy();

    await pressBack();
    expect(screen.queryByTestId('unsaved-keep-editing')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit item' })).toBeTruthy();

    // And the dialog still holds an entry underneath, so it is still Back that answers it.
    await pressBack();
    expect(screen.getByTestId('unsaved-keep-editing')).toBeTruthy();
  });

  it('does not chase an abandoned entry when the dismissal pushes a replacement over it', async () => {
    baseEntry();
    // An entry the seam could not reclaim: released while a later surface still sits above it,
    // so it is stranded directly beneath the live one. (`flushReleases` declines rather than
    // pop a run that is no longer at the top of the stack.)
    const stranded = pushDialogHistoryEntry(vi.fn());
    render(<BusyModalHarness busy />);
    await waitFor(() => expect(marker()).toBeTypeOf('string'));
    releaseDialogHistoryEntry(stranded);
    await settle();

    // Back lands on the dead marker. Stepping over it would be a trap: the refusal above has
    // already pushed a replacement, so going back again would land on the dead entry once more
    // and never stop.
    await pressBack();

    expect(screen.getByRole('dialog', { name: 'Restore backup' })).toBeTruthy();
  });

  it('hands its entry back when closed by the ✕', async () => {
    const base = baseEntry();
    render(<BusyModalHarness busy={false} />);
    await waitFor(() => expect(marker()).toBeTypeOf('string'));

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.history.state).toEqual(base);
  });
});
