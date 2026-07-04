import { useMemo } from 'react';
import { Button, ReorderList, type ReorderListItem } from '@/components/foundry';
import { ResetIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  BUILTIN_CARD_FIELDS,
  DEFAULT_CARD_FIELDS,
  moveCardField,
  normaliseCardFields,
  parseCustomCardFieldId,
  setCardFieldVisible,
} from '../card-fields';
import { useAllCategoryFields, useCategories } from '../categories';

/**
 * Settings → Inventory picker for the configurable item-card fields (backlog E1). Reorder and
 * show/hide the attributes each card/row shows, via the Foundry {@link ReorderList} (keyboard-
 * operable move/hide buttons — no drag-only affordance). The persisted preference is the
 * user's *intent*; it's reconciled against the live custom-field catalog here, so the picker
 * always lists the full current field set and never a stale one. Built-in fields are labelled
 * from the SSOT; each custom field shows its name and owning category.
 */
export function CardFieldsSetting() {
  const savedConfig = usePreferencesStore((s) => s.cardFields);
  const setCardFields = usePreferencesStore((s) => s.setCardFields);
  const resetCardFields = usePreferencesStore((s) => s.resetCardFields);
  const allFields = useAllCategoryFields();
  const categories = useCategories();

  const customFieldIds = useMemo(() => (allFields.data ?? []).map((f) => f.id), [allFields.data]);
  const config = useMemo(
    () => normaliseCardFields(savedConfig, customFieldIds),
    [savedConfig, customFieldIds],
  );

  const categoryNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories.data?.rows ?? []) map.set(c.id, c.name);
    return map;
  }, [categories.data]);

  // Resolve each field id to a display label + a plain accessible name for its controls.
  const items = useMemo<ReorderListItem[]>(() => {
    const builtinLabels = new Map(BUILTIN_CARD_FIELDS.map((f) => [f.id as string, f.label]));
    const fieldById = new Map((allFields.data ?? []).map((f) => [f.id, f]));
    return config.map((entry) => {
      const customId = parseCustomCardFieldId(entry.id);
      if (customId !== null) {
        const field = fieldById.get(customId);
        const name = field?.name ?? 'Custom field';
        const category = field ? categoryNames.get(field.categoryId) : undefined;
        return {
          id: entry.id,
          name: category ? `${name} (${category})` : name,
          visible: entry.visible,
          label: (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{name}</span>
              {category ? <span className="shrink-0 text-xs text-muted-foreground">· {category}</span> : null}
            </span>
          ),
        };
      }
      const label = builtinLabels.get(entry.id) ?? entry.id;
      return { id: entry.id, name: label, visible: entry.visible, label };
    });
  }, [config, allFields.data, categoryNames]);

  const isDefault = savedConfig === DEFAULT_CARD_FIELDS;

  return (
    <div className="space-y-3">
      <ReorderList
        aria-label="Item card fields"
        data-testid="card-fields-picker"
        items={items}
        onMove={(id, dir) => setCardFields(moveCardField(config, id, dir))}
        onToggleVisible={(id, visible) => setCardFields(setCardFieldVisible(config, id, visible))}
      />
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={resetCardFields}
          disabled={isDefault}
          data-testid="reset-card-fields"
        >
          <ResetIcon />
          Reset to default
        </Button>
      </div>
    </div>
  );
}
