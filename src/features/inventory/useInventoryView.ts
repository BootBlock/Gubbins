/**
 * Read and write the Inventory screen's view state through the `/inventory` URL (issue #574).
 *
 * The screen keeps no filter state of its own: this hook decodes the current search params into
 * an {@link InventoryView} and hands back a setter that navigates. Every narrowing therefore
 * makes a history entry, so Back undoes it, a reload lands on the same list, and the address bar
 * can be copied to someone else.
 *
 * **Which changes push, and which replace.** A deliberate act — picking a location, toggling a
 * chip, turning a page — is a real history entry: Back should undo it. Keystroke-level churn is
 * not: the quick-search box is debounced and written with `replace: true`, so typing "resistor"
 * leaves one entry rather than eight, and Back from a search returns to the list before it. Pass
 * `replace` at the call site to say which of the two a change is.
 *
 * **Two identities the screen depends on.** `setView` is stable for the screen's lifetime — it
 * reads the current view through a ref — so the callbacks built on it can be passed to memoised
 * list rows and the location tree without re-rendering them on every filter change. The decoded
 * `statuses` and `tagIds` arrays are memoised on their own params rather than on the whole search
 * object, so turning a page does not mint new arrays and invalidate every item query key with it.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  applyInventoryViewPatch,
  decodeInventoryView,
  decodeStatusList,
  decodeTagIdList,
  encodeInventoryView,
  type InventoryView,
} from './view-params';

/** A change to apply, or a function producing one from the view it is applied to. */
export type InventoryViewPatch =
  Partial<InventoryView> | ((current: InventoryView) => Partial<InventoryView>);

export interface InventoryViewApi {
  /** The view the URL currently describes. */
  readonly view: InventoryView;
  /**
   * Navigate to the same screen with `patch` applied. Any patch touching a filter axis resets
   * the page (see {@link applyInventoryViewPatch}).
   */
  readonly setView: (patch: InventoryViewPatch, options?: { readonly replace?: boolean }) => void;
}

export function useInventoryView(): InventoryViewApi {
  const params = useSearch({ from: '/inventory' });
  const navigate = useNavigate();

  // Decoded once, then given back its two memoised lists — `decodeInventoryView` stays the single
  // definition of what a URL means, and the arrays it hands over are the ones that keep their
  // identity across an unrelated param change.
  const statuses = useMemo(() => decodeStatusList(params.status), [params.status]);
  const tagIds = useMemo(() => decodeTagIdList(params.tags), [params.tags]);
  const decoded = useMemo(() => decodeInventoryView(params), [params]);
  const view = useMemo<InventoryView>(() => ({ ...decoded, statuses, tagIds }), [decoded, statuses, tagIds]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = useCallback(
    (patch: InventoryViewPatch, options?: { readonly replace?: boolean }) => {
      const current = viewRef.current;
      const resolved = typeof patch === 'function' ? patch(current) : patch;
      // The object form replaces the search wholesale, which is what dropping an axis back to
      // its default needs — `encodeInventoryView` omits those keys, so they leave the URL.
      const search = encodeInventoryView(applyInventoryViewPatch(current, resolved));
      void navigate({ to: '/inventory', search, replace: options?.replace ?? false });
    },
    [navigate],
  );

  return { view, setView };
}
