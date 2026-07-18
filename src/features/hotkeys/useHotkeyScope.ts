/**
 * Contextual, per-screen shortcuts — the scope registry (issue #127).
 *
 * Two actions in the registry (`screen.new` and `screen.search`) deliberately have no fixed
 * meaning: `N` should create whatever the screen you are looking at creates, and `/` should focus
 * whatever search box it offers. That is the only way a bare, unmodified key is affordable — a
 * global `N` would have to pick one screen's idea of "new" and be wrong everywhere else.
 *
 * So screens *offer* handlers instead, and the global dispatcher asks who is currently on top:
 *
 * ```tsx
 * useHotkeyScope({ onNew: () => setCreating(true), onSearch: () => searchRef.current?.focus() });
 * ```
 *
 * **Why a stack rather than one slot.** Screens do not unmount in a tidy order — a route change
 * mounts the incoming screen before the outgoing one has torn down, so a single slot would leave
 * the *departing* screen's handler installed. Each registration gets its own entry and the newest
 * one holding a given handler wins, so an overlapping mount is transient rather than wrong.
 *
 * A press with no registered handler resolves to nothing at all and is left for the browser —
 * that is what keeps `/` typing a slash on a screen with no search, rather than silently doing
 * nothing (see `stepHotkeySequence`'s `idle`).
 */
import { useEffect, useId } from 'react';
import { create } from 'zustand';

/** The handlers a screen may offer; either may be omitted when the screen has no such action. */
export interface HotkeyScopeHandlers {
  /** Create the thing this screen is a list of — "new project", "add item", … */
  readonly onNew?: () => void;
  /** Put the caret in this screen's search box. */
  readonly onSearch?: () => void;
}

interface ScopeEntry extends HotkeyScopeHandlers {
  readonly id: string;
}

interface HotkeyScopeStore {
  /** Registration order — the last entry is the innermost/newest scope. */
  readonly entries: readonly ScopeEntry[];
  register: (entry: ScopeEntry) => void;
  unregister: (id: string) => void;
}

export const useHotkeyScopeStore = create<HotkeyScopeStore>((set) => ({
  entries: [],
  register: (entry) =>
    set((state) => ({
      // Replace in place when the same scope re-registers (its handlers changed), so a screen
      // whose callbacks are re-created each render doesn't climb the stack forever.
      entries: [...state.entries.filter((e) => e.id !== entry.id), entry],
    })),
  unregister: (id) => set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),
}));

/**
 * Read the handler currently owning a scoped command, or `undefined` when no screen offers it.
 * Called from the dispatcher (outside React), so it reads the store imperatively.
 */
export function activeScopeHandler(command: 'screen-new' | 'screen-search'): (() => void) | undefined {
  const { entries } = useHotkeyScopeStore.getState();
  const key = command === 'screen-new' ? 'onNew' : 'onSearch';
  // Newest first — the screen in front of the user wins.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const handler = entries[i]?.[key];
    if (handler) return handler;
  }
  return undefined;
}

/**
 * Offer this screen's "new" and "focus search" actions to the contextual shortcuts.
 *
 * Handlers are held in a ref-like registration keyed by a stable per-instance id, so passing
 * inline arrows (the normal case) neither re-registers on every render nor leaves a stale closure
 * behind: the entry is rewritten in place whenever the callbacks change.
 */
export function useHotkeyScope(handlers: HotkeyScopeHandlers): void {
  const id = useId();
  const { onNew, onSearch } = handlers;

  useEffect(() => {
    useHotkeyScopeStore.getState().register({ id, onNew, onSearch });
    return () => useHotkeyScopeStore.getState().unregister(id);
  }, [id, onNew, onSearch]);
}
