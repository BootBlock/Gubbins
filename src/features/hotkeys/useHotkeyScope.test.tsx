/**
 * The contextual-shortcut scope registry (issue #127) — who owns `N` and `/` right now.
 *
 * The interesting behaviour is all about *overlap*: screens do not unmount tidily, so the rules
 * for which registration wins (and what happens when the winner leaves) are what these cover.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { activeScopeHandler, useHotkeyScope, useHotkeyScopeStore } from './useHotkeyScope';

/** A component that does nothing but offer handlers to the registry. */
function Scope({ onNew, onSearch }: { readonly onNew?: () => void; readonly onSearch?: () => void }) {
  useHotkeyScope({ onNew, onSearch });
  return null;
}

afterEach(() => {
  cleanup();
  useHotkeyScopeStore.setState({ entries: [] });
});

describe('useHotkeyScope', () => {
  it('offers nothing when no screen has registered', () => {
    expect(activeScopeHandler('screen-new')).toBeUndefined();
    expect(activeScopeHandler('screen-search')).toBeUndefined();
  });

  it('routes a scoped command to the registered handler', () => {
    const onNew = vi.fn();
    render(<Scope onNew={onNew} />);
    activeScopeHandler('screen-new')?.();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('leaves a command unhandled when the screen offers only the other one', () => {
    // The screen has a search box but nothing to create — `N` must fall through to the browser
    // rather than silently doing nothing.
    render(<Scope onSearch={vi.fn()} />);
    expect(activeScopeHandler('screen-new')).toBeUndefined();
    expect(activeScopeHandler('screen-search')).toBeDefined();
  });

  it('gives the newest registration the command when two overlap', () => {
    const outgoing = vi.fn();
    const incoming = vi.fn();
    render(
      <>
        <Scope onNew={outgoing} />
        <Scope onNew={incoming} />
      </>,
    );
    activeScopeHandler('screen-new')?.();
    expect(incoming).toHaveBeenCalledOnce();
    expect(outgoing).not.toHaveBeenCalled();
  });

  it('hands the command back when the winning scope unmounts', () => {
    const remaining = vi.fn();
    const leaving = vi.fn();
    const { rerender } = render(
      <>
        <Scope onNew={remaining} />
        <Scope onNew={leaving} />
      </>,
    );
    rerender(
      <>
        <Scope onNew={remaining} />
      </>,
    );
    activeScopeHandler('screen-new')?.();
    expect(remaining).toHaveBeenCalledOnce();
    expect(leaving).not.toHaveBeenCalled();
  });

  it('unregisters entirely on unmount, so a departed screen keeps no claim', () => {
    const { unmount } = render(<Scope onNew={vi.fn()} />);
    unmount();
    expect(activeScopeHandler('screen-new')).toBeUndefined();
  });

  it('replaces its entry in place rather than stacking one per render', () => {
    // A screen passing inline arrows re-registers on every render; without replace-in-place the
    // stack would grow without bound and leak stale closures.
    const { rerender } = render(<Scope onNew={() => {}} />);
    for (let i = 0; i < 5; i += 1) rerender(<Scope onNew={() => {}} />);
    expect(useHotkeyScopeStore.getState().entries).toHaveLength(1);
  });

  it('routes to the latest handler after a re-render, not the first one', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(<Scope onNew={stale} />);
    rerender(<Scope onNew={fresh} />);
    activeScopeHandler('screen-new')?.();
    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });
});
