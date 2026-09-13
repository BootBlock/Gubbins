/**
 * Tests for the primary-content gate (issue #1575) — the seam that keeps a screen's own list
 * ahead of the reads around it on the single worker connection.
 *
 * Each probe records the gate's answer on every render, so the tests can state *when* it opens
 * rather than only that it eventually does: the one-commit delay is the part that decides the
 * order the worker sees, because the reads a screen's arriving content mounts are posted in the
 * commit the gate deliberately waits for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  PrimaryContentProvider,
  useAfterPrimaryContent,
  useAfterScreenReads,
  useAfterSettled,
} from './index';

afterEach(cleanup);

/** Reports `useAfterSettled`, recording what it answered on each render. */
function SettledProbe({
  settled,
  scope,
  seen,
}: {
  readonly settled: boolean;
  readonly scope?: unknown;
  readonly seen: boolean[];
}) {
  const open = useAfterSettled(settled, scope);
  seen.push(open);
  return <span data-testid="open">{String(open)}</span>;
}

/** The same, through the context a screen provides. */
function ContextProbe({ scope, seen }: { readonly scope?: unknown; readonly seen: boolean[] }) {
  const open = useAfterPrimaryContent(scope);
  seen.push(open);
  return <span data-testid="open">{String(open)}</span>;
}

function isOpen(): boolean {
  return screen.getByTestId('open').textContent === 'true';
}

describe('useAfterSettled — the deferral itself', () => {
  it('opens one commit after the primary read settles, so that read reaches the worker first', () => {
    const seen: boolean[] = [];
    render(<SettledProbe settled seen={seen} />);
    // Closed on the render that saw `settled`, open on the next: anything the arriving content
    // mounts (a grouped section, a card's field values) is posted in between.
    expect(seen[0]).toBe(false);
    expect(isOpen()).toBe(true);
  });

  it('stays shut while the primary read is unsettled', () => {
    const seen: boolean[] = [];
    const { rerender } = render(<SettledProbe settled={false} seen={seen} />);
    expect(isOpen()).toBe(false);

    rerender(<SettledProbe settled={false} seen={seen} />);
    expect(isOpen()).toBe(false);
    expect(seen.every((open) => !open)).toBe(true);
  });

  it('latches, so a later refetch of the primary read never shuts a deferred read off again', () => {
    // Shutting it again would flip `enabled` back and forth, and TanStack Query re-fetches a
    // stale query the moment it is re-enabled — turning the gate into extra work rather than less.
    const seen: boolean[] = [];
    const { rerender } = render(<SettledProbe settled seen={seen} />);
    expect(isOpen()).toBe(true);

    rerender(<SettledProbe settled={false} seen={seen} />);
    expect(isOpen()).toBe(true);
  });

  it('waits again when the scope changes, because that read is now a different read', () => {
    const seen: boolean[] = [];
    const { rerender } = render(<SettledProbe settled scope="loc-1" seen={seen} />);
    expect(isOpen()).toBe(true);

    // A new location: the primary read is loading that location's list, and the deferred read is
    // keyed by the same location, so it must not race it.
    rerender(<SettledProbe settled={false} scope="loc-2" seen={seen} />);
    expect(isOpen()).toBe(false);

    rerender(<SettledProbe settled scope="loc-2" seen={seen} />);
    expect(isOpen()).toBe(true);
  });

  it('holds a scope of null apart from "never opened"', () => {
    // `null` is the scope a screen-wide read passes, so it has to be a scope like any other
    // rather than reading as "no scope recorded yet". Were the latch stored unboxed, a `null`
    // scope would match the "never opened" state and report open on the very first render —
    // which is what the first recorded answer pins.
    const seen: boolean[] = [];
    const { rerender } = render(<SettledProbe settled scope={null} seen={seen} />);
    expect(seen[0]).toBe(false);
    expect(isOpen()).toBe(true);

    rerender(<SettledProbe settled={false} scope={null} seen={seen} />);
    expect(isOpen()).toBe(true);
  });
});

describe('useAfterPrimaryContent — what the chrome around a screen asks', () => {
  it('reads from the first render where no screen declares primary content', () => {
    // Every other screen keeps the behaviour it had: no provider, no waiting — and no second
    // render either, so a gate nobody uses costs nothing.
    const seen: boolean[] = [];
    render(<ContextProbe seen={seen} />);
    expect(seen).toEqual([true]);
  });

  it('waits for the screen that does declare it', () => {
    const seen: boolean[] = [];
    const { rerender } = render(
      <PrimaryContentProvider settled={false}>
        <ContextProbe seen={seen} />
      </PrimaryContentProvider>,
    );
    expect(isOpen()).toBe(false);

    rerender(
      <PrimaryContentProvider settled>
        <ContextProbe seen={seen} />
      </PrimaryContentProvider>,
    );
    expect(isOpen()).toBe(true);
  });

  it('lets chrome read from the first render where no screen declares primary content', () => {
    // The chrome hook waits two steps, but only where there is something to wait for. Chaining
    // the second step unconditionally would make every other screen's chrome pass through a
    // commit with its reads switched off — a state its consumers can mistake for an answer.
    const seen: boolean[] = [];
    function ChromeProbe() {
      seen.push(useAfterScreenReads());
      return null;
    }
    render(<ChromeProbe />);

    expect(seen).toEqual([true]);
  });

  it('puts chrome behind the screen refinements it sits beside', () => {
    // The chrome gate must open strictly later, because the screen's own deferred reads are
    // posted in the commit where the content gate opens — that is what puts them first in the
    // worker's queue rather than whichever component happens to render first.
    const content: boolean[] = [];
    const chrome: boolean[] = [];
    function BothProbe() {
      content.push(useAfterPrimaryContent());
      chrome.push(useAfterScreenReads());
      return null;
    }
    render(
      <PrimaryContentProvider settled>
        <BothProbe />
      </PrimaryContentProvider>,
    );

    expect(content.indexOf(true)).toBeGreaterThanOrEqual(0);
    expect(chrome.indexOf(true)).toBeGreaterThan(content.indexOf(true));
  });

  it('carries the scope through, so a location change makes the read wait again', () => {
    const seen: boolean[] = [];
    const { rerender } = render(
      <PrimaryContentProvider settled>
        <ContextProbe scope="loc-1" seen={seen} />
      </PrimaryContentProvider>,
    );
    expect(isOpen()).toBe(true);

    rerender(
      <PrimaryContentProvider settled={false}>
        <ContextProbe scope="loc-2" seen={seen} />
      </PrimaryContentProvider>,
    );
    expect(isOpen()).toBe(false);
  });
});
