import { useMemo } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  normaliseCardFields,
  parseCustomCardFieldId,
  visibleCardFieldIds,
  type CardCustomField,
} from '../card-fields';
import { useAllCategoryFields, useCategories } from '../categories';

/**
 * Resolves the persisted card-field preference against the live category/custom-field
 * catalog (backlog E1), producing everything the item list needs *except* the per-window
 * custom-field values (which each list scope fetches for its own on-screen items). Reused by
 * the flat virtualised list and the grouped list so both render identical fields.
 */
export interface CardFieldsConfigBundle {
  /** The visible field ids, in order — the input the card renderer iterates. */
  readonly order: readonly string[];
  /** The live custom-field catalog, keyed by field id. */
  readonly customFields: ReadonlyMap<string, CardCustomField>;
  /** Resolve a category id to its name (null when the item has no category). */
  readonly categoryName: (categoryId: string | null) => string | null;
  /**
   * Resolve a category id to its decorative glyph for the card watermark (issue #83), or null
   * when the category has none *or* the global category-watermark setting is off — so a card
   * never needs to know the setting itself.
   */
  readonly categoryGlyph: (categoryId: string | null) => string | null;
  /** Whether any *visible* field is a custom field — gates the per-window value fetch. */
  readonly hasCustomFields: boolean;
  /** Whether the Tags field is visible (issue #84) — gates the per-window tags fetch. */
  readonly hasTagsField: boolean;
}

/**
 * Wire the Tier-2 `cardFields` preference to the live catalog. The preference holds the
 * user's *intent*; here it is reconciled (`normaliseCardFields`) against the current custom
 * fields so a renamed/removed field or a newly-added built-in never corrupts the card. The
 * category names and the custom-field catalog come from the bounded category reads (shared,
 * cached), so this adds no per-item query.
 */
export function useCardFieldsConfig(): CardFieldsConfigBundle {
  const savedConfig = usePreferencesStore((s) => s.cardFields);
  const categoryWatermarks = usePreferencesStore((s) => s.categoryWatermarks);
  const allFields = useAllCategoryFields();
  const categories = useCategories();

  const customFieldIds = useMemo(() => (allFields.data ?? []).map((f) => f.id), [allFields.data]);

  const order = useMemo(
    () => visibleCardFieldIds(normaliseCardFields(savedConfig, customFieldIds)),
    [savedConfig, customFieldIds],
  );

  const customFields = useMemo(() => {
    const map = new Map<string, CardCustomField>();
    for (const f of allFields.data ?? []) {
      map.set(f.id, {
        id: f.id,
        categoryId: f.categoryId,
        name: f.name,
        fieldType: f.fieldType,
        defaultValue: f.defaultValue,
      });
    }
    return map;
  }, [allFields.data]);

  const categoryNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories.data?.rows ?? []) map.set(c.id, c.name);
    return map;
  }, [categories.data]);

  const categoryGlyphsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories.data?.rows ?? []) if (c.glyph) map.set(c.id, c.glyph);
    return map;
  }, [categories.data]);

  const hasCustomFields = useMemo(() => order.some((id) => parseCustomCardFieldId(id) !== null), [order]);
  const hasTagsField = useMemo(() => order.includes('tags'), [order]);

  // Plain closures (not memoised): they're called during the list's own render to produce a
  // string per item, and the card memo compares that string — not the function's identity.
  const categoryName = (categoryId: string | null): string | null =>
    categoryId ? (categoryNamesById.get(categoryId) ?? null) : null;

  // Null when the global watermark setting is off, so a card never renders the glyph and the
  // memoised card sees a stable null — no per-card subscription to the setting.
  const categoryGlyph = (categoryId: string | null): string | null =>
    categoryWatermarks && categoryId ? (categoryGlyphsById.get(categoryId) ?? null) : null;

  return { order, customFields, categoryName, categoryGlyph, hasCustomFields, hasTagsField };
}
