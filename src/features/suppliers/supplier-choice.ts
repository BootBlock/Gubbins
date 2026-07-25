/**
 * {@link SupplierSearchField}'s value shape and its name resolution — a pure seam, kept out of
 * the component file so it is unit-testable in isolation (and so the component module exports
 * only components, for fast-refresh). Sits beside {@link supplier-picker-value} for the same
 * reason, and is deliberately *not* the same type: that one may hold a name you have never
 * used (typing it creates a supplier), where this one only ever names an existing row.
 */
import type { SupplierWithCounts } from '@/db/repositories';
import { isSameSupplierName, normaliseSupplierName } from '@/lib/supplier-name';

/**
 * What the field holds: the text the user typed, and the supplier it resolves to (`null` when
 * it names none). Both travel together because the caller needs each for a different job — the
 * supplier to act on, the text to keep on screen while a search is still settling — and because
 * keeping them in one state makes clearing the field a single assignment rather than two that
 * could disagree.
 */
export interface SupplierChoice {
  readonly text: string;
  readonly supplier: SupplierWithCounts | null;
}

/** The empty field: nothing typed, nothing chosen. */
export const NO_SUPPLIER_CHOICE: SupplierChoice = { text: '', supplier: null };

/**
 * The supplier `text` names among `matches`, under the canonical fold (case, spacing and
 * punctuation) — so `rs-components` selects the `RS Components` the search returned.
 *
 * Anything short of a whole name resolves to `null`. That is the point: this backs a control
 * that picks an *existing* supplier for a destructive operation, so there is no "close enough"
 * reading that could fold the wrong company into another.
 */
export function resolveSupplier(
  matches: readonly SupplierWithCounts[],
  text: string,
): SupplierWithCounts | null {
  const name = normaliseSupplierName(text);
  if (name.length === 0) return null;
  return matches.find((s) => isSameSupplierName(s.name, name)) ?? null;
}
