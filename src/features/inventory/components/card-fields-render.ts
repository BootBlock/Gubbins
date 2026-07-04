import { useMemo } from 'react';
import type { Item } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { resolveCardFields, type CardCustomField, type ResolvedCardField } from '../card-fields';

/**
 * Non-component render helpers for the configurable item-card fields (backlog E1) — the hook
 * and prop-plumbing that pair with the JSX in `ItemCardFields.tsx`. Kept in a plain module so
 * the components file exports only components (fast-refresh friendly).
 */

/** A stable empty catalog, so a card rendered before the catalog loads doesn't churn its memo. */
export const EMPTY_CUSTOM_FIELDS: ReadonlyMap<string, CardCustomField> = new Map();

/** The per-item + shared inputs a card/row needs to resolve its fields (minus the formatters). */
export interface CardFieldsInputs {
  /** The visible field ids, in order (from `visibleCardFieldIds`). */
  readonly order: readonly string[];
  readonly locationName: string;
  readonly categoryName: string | null;
  /** The live custom-field catalog, keyed by field id. */
  readonly customFields: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values, if loaded. */
  readonly customValues: ReadonlyMap<string, string> | undefined;
}

/** Resolve an item's visible fields, binding the shared formatters (memoised per item/config). */
export function useResolvedCardFields(item: Item, inputs: CardFieldsInputs): ResolvedCardField[] {
  const fmt = useFormatters();
  const { order, locationName, categoryName, customFields, customValues } = inputs;
  return useMemo(
    () =>
      resolveCardFields(order, item, {
        locationName,
        categoryName,
        customFields,
        customValues,
        fmt: { quantity: fmt.quantity, relativeTime: fmt.relativeTime },
      }),
    [order, item, locationName, categoryName, customFields, customValues, fmt],
  );
}

/**
 * Everything a list scope hands each card/row to render its fields: the shared config bundle
 * (order + catalog + category-name resolver) plus the stored custom-field values for the
 * items currently on screen (fetched per scope). Spread onto a card via {@link cardFieldProps}.
 */
export interface CardFieldsListContext {
  readonly order: readonly string[];
  readonly customFields: ReadonlyMap<string, CardCustomField>;
  readonly categoryName: (categoryId: string | null) => string | null;
  /** itemId → (fieldId → stored value) for the on-screen items, or undefined while loading. */
  readonly values: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined;
}

/** The per-item card-field props derived from a list context — spread onto `ItemCard`/`ItemRow`. */
export function cardFieldProps(ctx: CardFieldsListContext, item: Item) {
  return {
    fieldOrder: ctx.order,
    categoryName: ctx.categoryName(item.categoryId),
    customFields: ctx.customFields,
    customValues: ctx.values?.get(item.id),
  };
}
