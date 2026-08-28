/**
 * The glue that turns Foundry's {@link Autocomplete} into an **entity picker** — a combobox whose
 * value is a row's id rather than the text in the box (issue #484).
 *
 * A picker like that has two halves that are easy to get subtly wrong, and both are here rather
 * than copied into each picker:
 *
 * 1. **Label ↔ row.** The combobox offers strings and hands one back, so a label has to resolve to
 *    exactly one row. Two rows can legitimately be named the same, and matching on the label alone
 *    would silently pick whichever came first.
 * 2. **Whose change is it?** The box reports `null` on every keystroke that does not name a row, so
 *    "the value is null" cannot mean "the caller cleared the field" — treating it as such would
 *    wipe the very text being typed. The controller tells the two apart.
 *
 * Entity-agnostic on purpose: the item picker and the project picker differ only in which reads
 * supply the rows.
 */
import { useEffect, useMemo, useRef } from 'react';

/** One row's identity and display name, as a picker needs them. */
export interface PickerRowAccess<T> {
  readonly labelFor: (row: T) => string;
  readonly idFor: (row: T) => string;
}

/**
 * Map every row to the label the picker offers for it, in the order given. A label that would
 * repeat takes a ` (abc123)` id fragment, so the second and later rows sharing a name stay
 * individually pickable rather than being shadowed by the first.
 */
export function buildPickerLabelMap<T>(rows: readonly T[], access: PickerRowAccess<T>): Map<string, T> {
  const seen = new Map<string, number>();
  const out = new Map<string, T>();
  for (const row of rows) {
    const base = access.labelFor(row);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base} (${access.idFor(row).slice(0, 6)})`, row);
  }
  return out;
}

export interface PickerSelection {
  /** The labels to offer. Already narrowed by whoever supplied the rows. */
  readonly suggestions: readonly string[];
  /** The combobox's `onChange` — resolves the text to a row and reports the outcome. */
  readonly onText: (next: string) => void;
}

export interface PickerSelectionParams<T> extends PickerRowAccess<T> {
  /** The chosen row's id, or `null` / `''` for "nothing chosen". */
  readonly value: string | null;
  /** Reports the id the box now names, with the row itself when one was resolved. */
  readonly onChange: (id: string | null, row?: T) => void;
  /** The rows on offer, in the order to offer them. */
  readonly rows: readonly T[];
  /**
   * Writes the box's text. The picker owns that state, because the text is also what its search
   * read is asked for; the controller only writes it when the *caller* moves the value — filling
   * in a name for a value set from outside, or clearing the box when one is taken away.
   */
  readonly setText: (next: string) => void;
  /**
   * The row `value` identifies, once the caller has read it. Only consulted when the value came
   * from *outside* the box — that is what the picker needs a name for.
   */
  readonly resolved?: T;
}

/**
 * Drive an entity picker's text box from an id-valued selection.
 *
 * The box is filled from `resolved` when a value arrives from outside — a form default, or a
 * setting remembered across opens — and emptied when the caller clears one. A value the box itself
 * reported is left alone, so typing is never interrupted by the round trip through the caller.
 */
export function usePickerSelection<T>({
  value,
  onChange,
  rows,
  setText,
  resolved,
  labelFor,
  idFor,
}: PickerSelectionParams<T>): PickerSelection {
  // `''` is how several callers spell "nothing chosen"; normalise so only one of the two spellings
  // is compared against anywhere below.
  const valueId = value === null || value === '' ? null : value;

  const byLabel = useMemo(() => buildPickerLabelMap(rows, { labelFor, idFor }), [rows, labelFor, idFor]);
  const suggestions = useMemo(() => [...byLabel.keys()], [byLabel]);

  /**
   * The last id this controller itself reported — what separates a caller-driven change from the
   * echo of its own `onChange`.
   *
   * It starts at `null` even when a value is already set, so a value the picker is *mounted* with
   * counts as caller-set and fills the box with that row's name. The export wizard remembers its
   * last target across opens, and an empty box beside a live target is a lie about what the export
   * will cover.
   */
  const emittedRef = useRef<string | null>(null);

  // Held in a ref so the sync effect never re-runs merely because the caller passed fresh arrow
  // functions this render; the label map, which does need to track them, recomputes.
  const accessRef = useRef({ labelFor, idFor });
  useEffect(() => {
    accessRef.current = { labelFor, idFor };
  });

  useEffect(() => {
    if (valueId === emittedRef.current) return;
    if (valueId === null) {
      emittedRef.current = null;
      setText('');
      return;
    }
    // Set from outside: wait for the row, so the box shows its name rather than an id.
    if (resolved !== undefined && accessRef.current.idFor(resolved) === valueId) {
      emittedRef.current = valueId;
      setText(accessRef.current.labelFor(resolved));
    }
    // `setText` is a `useState` setter and therefore stable; the access functions are read from
    // the ref above, so this effect runs on a genuine value change and nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueId, resolved]);

  const onText = (next: string) => {
    setText(next);
    const match = byLabel.get(next.trim());
    const nextId = match === undefined ? null : idFor(match);
    emittedRef.current = nextId;
    if (nextId !== valueId) onChange(nextId, match);
  };

  return { suggestions, onText };
}
