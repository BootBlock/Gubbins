/**
 * The Add/Edit item dialogs' **duplicate-name advisory** (issue #99).
 *
 * Creating a second "M3 x 10 socket screws" is legitimate — a different size, a different
 * supplier, a genuinely separate physical thing — so this is an advisory in the same
 * non-blocking style as the Barcode field's, never a rejection. What it buys the user is
 * knowing, at the moment they could still change their mind, that the record they are about to
 * add is one they may already have. That is the point at which a duplicate is free to avoid; the
 * Deduplicate-items tool is what is left once it is not.
 *
 * It says two different things, and the difference matters:
 *
 * - an **exact** match, where the two names fold to one key (`lib/name-fold`) and so differ only
 *   by case, spacing or Unicode composition — a duplicate nobody could tell apart on screen;
 * - a **similar** name, above a normalised edit-distance threshold. This one guesses, so it is
 *   worded as a possibility rather than a fact.
 *
 * Like the Barcode field, the check waits for **blur** rather than firing per keystroke. A name
 * is transiently a near-match to something else at almost every point on the way to being typed
 * (`Screw` on the way to `Screwdriver`), and an advisory that flickers as the user types is noise
 * rather than help. Editing again clears it until they next leave the field. A value the user did
 * *not* type — the stored name of an item being edited, or one that arrives when the editor
 * switches items — is judged straight away, since it is finished by definition.
 */
import { useState } from 'react';
import { useT } from '@/features/i18n';
import { useNameMatches } from '../queries';

export interface DuplicateNameAdvisory {
  /** The advisory to pass to `FormField`'s `warning`, or `''` when there is nothing to say. */
  readonly warning: string;
  /** Call from the input's `onChange`: the user is mid-name, so suppress the advisory. */
  readonly onEdit: () => void;
  /** Call from the input's `onBlur`: the name is finished, so judge it. */
  readonly onSettle: () => void;
}

/**
 * Judge `name` against the items that already exist.
 *
 * @param name the current field value.
 * @param itemId the item being edited, so its own name is never reported against itself. Omitted
 *   on the Add form, where there is no record to exclude yet.
 */
export function useDuplicateNameWarning(name: string, itemId?: string): DuplicateNameAdvisory {
  const t = useT();
  // Mid-keystroke is the *only* state that suppresses the check, so a name that arrives from
  // anywhere else — an item's stored name, a switch to another item — is judged the moment it
  // lands, with no interaction needed to reveal it.
  const [editing, setEditing] = useState(false);

  const matches = useNameMatches(editing ? '' : name);
  const others = (matches.data ?? []).filter((match) => match.id !== itemId);
  const exact = others.filter((match) => match.exact);
  const similar = others.filter((match) => !match.exact);

  const warning =
    exact.length > 0
      ? t('inventory.name.warning.duplicate', {
          vars: { count: exact.length, name: exact[0]!.name },
        })
      : similar.length > 0
        ? t('inventory.name.warning.similar', {
            vars: { count: similar.length, name: similar[0]!.name },
          })
        : '';

  return {
    warning,
    onEdit: () => setEditing(true),
    onSettle: () => setEditing(false),
  };
}
