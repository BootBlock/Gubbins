import { useEffect, useMemo, type ReactNode } from 'react';
import { AutocompleteField, LiveRegion } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { SUPPLIER_SEARCH_LIMIT, useSupplierSearch } from '../queries';
import { resolveSupplier, type SupplierChoice } from '../supplier-choice';

export interface SupplierSearchFieldProps {
  readonly label: ReactNode;
  /** Rich-Markdown help for the InfoHint badge. */
  readonly hint?: string;
  readonly value: SupplierChoice;
  readonly onChange: (next: SupplierChoice) => void;
  /** A supplier to leave out of the results (the other side of a merge). */
  readonly excludeId?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly 'data-testid'?: string;
}

/**
 * Choose one existing supplier out of the **whole** dictionary (issue #386).
 *
 * The merge dialog used to offer two dropdowns built from the single bounded page the screen
 * had read, which meant a duplicate pair that both sorted past that page could not be selected
 * at all — and reconciling duplicates is the entire reason merge exists. This searches the
 * database as you type instead, so reach no longer depends on how long the list is.
 *
 * Unlike the app-wide {@link SupplierPicker} — an *editable* combobox where typing an unknown
 * name creates a supplier — this one only ever resolves to a supplier that already exists.
 * Merging is destructive, so text that matches nothing selects nothing and says so; there is no
 * reading of "close enough" that could fold the wrong company into another.
 *
 * Built on Foundry's {@link AutocompleteField}, so the APG editable-combobox wiring (the
 * `aria-activedescendant` listbox, arrow/Home/End/Enter handling, Escape closing the list
 * rather than the enclosing Modal, and the labelled hint plumbing) is the one implementation
 * every picker shares.
 */
export function SupplierSearchField({
  label,
  hint,
  value,
  onChange,
  excludeId,
  placeholder,
  disabled,
  'data-testid': testId,
}: SupplierSearchFieldProps) {
  const t = useT();
  const { data, isFetching } = useSupplierSearch(value.text);

  // The other side of a merge can never also be this side, so it is simply not offered.
  const matches = useMemo(() => (data?.rows ?? []).filter((s) => s.id !== excludeId), [data, excludeId]);
  const names = useMemo(() => matches.map((s) => s.name), [matches]);

  const resolved = useMemo(() => resolveSupplier(matches, value.text), [matches, value.text]);

  /**
   * Report a resolution when the *results* change, not only when the text does: a name pasted in
   * whole (or typed faster than the search settles) is judged against results fetched for an
   * earlier term, and would otherwise stay unresolved even once the matching supplier arrives.
   * Excluding a supplier mid-flow lands here too, dropping a selection no longer on offer.
   *
   * Gated on results actually having arrived, so an in-flight first search can't read as "that
   * supplier doesn't exist" and un-choose a selection the caller opened the field with.
   */
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    if (resolved?.id !== value.supplier?.id) onChange({ text: value.text, supplier: resolved });
  }, [loaded, resolved, value, onChange]);

  // Speaks up only where the outcome would otherwise be invisible: text that selects nothing.
  // Silent while blank — nothing chosen yet is the starting state, not a problem to report — and
  // silent while a search is still running, since "no supplier is named that" is not yet known.
  const unmatched = value.text.trim().length > 0 && value.supplier === null && !isFetching;

  return (
    <div>
      <AutocompleteField
        label={label}
        hint={hint}
        value={value.text}
        onChange={(next) => onChange({ text: next, supplier: resolveSupplier(matches, next) })}
        suggestions={names}
        // A supplier dictionary is a browsable list: opening an empty field should show what
        // you actually have, not the type-ahead default of ten.
        maxOptions={SUPPLIER_SEARCH_LIMIT}
        placeholder={placeholder}
        disabled={disabled}
        data-testid={testId}
      />
      {/* Always mounted so the message is announced when it appears, not inserted with it. */}
      <LiveRegion className="mt-1 text-xs text-muted-foreground">
        {unmatched ? (
          <span data-testid={testId ? `${testId}-unmatched` : undefined}>
            {t('suppliers.search.noMatch', { vars: { query: value.text.trim() } })}
          </span>
        ) : null}
      </LiveRegion>
    </div>
  );
}
