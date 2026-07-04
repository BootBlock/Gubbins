import { useCallback, useRef, type MouseEvent } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { normaliseCardClickAction } from '@/features/settings/settings';
import { isInteractiveDragOrigin } from '../item-dnd';
import type { ItemActionsHandle, ItemDialogKind } from './ItemActions';

/**
 * The `cardClickAction` values that open a dialog (everything but `none`), mapped to the
 * matching {@link ItemDialogKind} the card's {@link ItemActions} already drives.
 */
const ACTION_DIALOG = {
  details: 'details',
  move: 'move',
  qr: 'qr',
} as const satisfies Record<string, ItemDialogKind>;

/**
 * Wires the user's `cardClickAction` preference (spec §3) to an item card/row: a plain click on
 * the card *body* opens one of the card's own dialogs (details / move / label), reusing the one
 * {@link ItemActions} instance via its imperative handle rather than a second copy of dialog
 * state. Shared by {@link ItemCard} and {@link ItemRow} so both densities behave identically.
 *
 * The shortcut is a **pointer-only convenience** that always mirrors a labelled button on the
 * card, so keyboard/AT users are unaffected. It is suppressed when `suppressed` is set (the
 * batch-selection flow, where a click means "toggle selection", not "open"), and a click that
 * originates on an interactive control (a button, the ± stepper, the select checkbox) is ignored
 * so that control keeps its own behaviour — the same guard the drag gesture uses.
 *
 * @returns `actionsRef` to attach to the card's `<ItemActions>`, an `onClick` handler for the
 * card root (or `undefined` when no action is active, so no listener is attached), and
 * `clickable` for the pointer-cursor affordance.
 */
export function useCardClickAction(suppressed: boolean): {
  actionsRef: React.RefObject<ItemActionsHandle | null>;
  onClick: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  clickable: boolean;
} {
  const actionsRef = useRef<ItemActionsHandle>(null);
  const action = normaliseCardClickAction(usePreferencesStore((s) => s.cardClickAction));
  const active = action !== 'none' && !suppressed;
  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      // Ignore clicks that bubbled up from one of the card's own dialogs. Those dialogs (Move,
      // details, label, …) are React children of the card, so their clicks bubble here through
      // the React tree — but they render in a portal *outside* the card's DOM. So a genuine
      // card-body click has its `target` inside `currentTarget`, whereas a click from an open
      // dialog does not. Without this, e.g. opening the Move dialog and clicking its Location
      // combobox (a `role="combobox"`, which the interactive-origin guard below doesn't match)
      // would re-fire the card action and pop the details dialog on top of it.
      if (!event.currentTarget.contains(event.target as Node)) return;
      // Guarded again here (not just in `active`) so a click bubbling up from a button/stepper
      // never doubles as a card-body click.
      if (action === 'none' || isInteractiveDragOrigin(event.target)) return;
      actionsRef.current?.open(ACTION_DIALOG[action]);
    },
    [action],
  );
  return { actionsRef, onClick: active ? onClick : undefined, clickable: active };
}
