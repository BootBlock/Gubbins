import { useMemo } from 'react';
import { Select } from '@/components/foundry';
import { CategoryIcon, CloseIcon, TagIcon } from '@/components/icons';
import { useFeature } from '@/features/modules/useFeature';
import { useCategories } from '../categories';
import { useTagDictionary } from '../tags';

/**
 * The inventory **facet bar** (spec §3 filter axis): attribute pickers that sit alongside the
 * derived-status {@link InventoryFilterBar} chips. Where the status chips answer "needs
 * attention?", the facets answer "which kind?" — narrowing by **Category** (single-select)
 * and **Tags** (multi-select). Facets AND with the status filters, the location scope and the
 * search; within the tag facet the selected tags OR together (any tag matches).
 *
 * Category is core inventory and always offered (when any category exists); the Tags facet is
 * gated on the `tags-attachments` capability (Modular UI, §4). The tag multi-select uses the
 * token/pill pattern — a Foundry {@link Select} to add a tag plus a removable chip per active
 * tag — rather than a bespoke popover, so it stays on the existing primitives.
 */
interface InventoryFacetBarProps {
  readonly categoryId: string | null;
  readonly onCategoryChange: (categoryId: string | null) => void;
  readonly tagIds: readonly string[];
  readonly onToggleTag: (tagId: string) => void;
  /** Disabled while the Visual Builder supersedes the quick filters (mirrors the search box). */
  readonly disabled?: boolean;
}

export function InventoryFacetBar({
  categoryId,
  onCategoryChange,
  tagIds,
  onToggleTag,
  disabled,
}: InventoryFacetBarProps) {
  const tagsEnabled = useFeature('tags-attachments');
  const categories = useCategories();
  const tagDictionary = useTagDictionary();

  const categoryRows = useMemo(() => categories.data?.rows ?? [], [categories.data]);
  const tagRows = useMemo(() => tagDictionary.data?.rows ?? [], [tagDictionary.data]);
  const tagName = useMemo(() => new Map(tagRows.map((t) => [t.id, t.name] as const)), [tagRows]);

  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'All categories' },
      ...categoryRows.map((cat) => ({ value: cat.id, label: cat.name })),
    ],
    [categoryRows],
  );
  // The "add a tag" picker only lists tags that are not already active.
  const selectable = useMemo(() => tagRows.filter((t) => !tagIds.includes(t.id)), [tagRows, tagIds]);
  const tagOptions = useMemo(
    () => [
      { value: '', label: 'Filter by tag…' },
      ...selectable.map((t) => ({ value: t.id, label: t.name })),
    ],
    [selectable],
  );

  const showCategory = categoryRows.length > 0;
  // The Tags facet appears once the capability is on and at least one tag exists (or one is
  // already active, so it can be cleared even after the last tag is deleted from the catalogue).
  const showTags = tagsEnabled && (tagRows.length > 0 || tagIds.length > 0);

  // Nothing to offer → render no row at all rather than an empty toolbar.
  if (!showCategory && !showTags) return null;

  return (
    <div
      role="group"
      aria-label="Filter by category and tags"
      data-testid="inventory-facet-bar"
      className="flex flex-wrap items-center gap-2 pb-3"
    >
      {showCategory ? (
        <span className="flex items-center gap-1.5">
          <CategoryIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <Select
            value={categoryId ?? ''}
            onChange={(value) => onCategoryChange(value || null)}
            options={categoryOptions}
            aria-label="Filter by category"
            data-testid="inventory-facet-category"
            disabled={disabled}
            className="w-48"
          />
        </span>
      ) : null}

      {showTags ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5">
            <TagIcon aria-hidden className="size-3.5 text-muted-foreground" />
            <Select
              // Kept controlled at '' — picking a tag adds it and the picker resets to the
              // placeholder so the next tag can be chosen.
              value=""
              onChange={(value) => value && onToggleTag(value)}
              options={tagOptions}
              aria-label="Add a tag filter"
              data-testid="inventory-facet-tag-add"
              disabled={disabled || selectable.length === 0}
              className="w-44"
            />
          </span>
          {tagIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onToggleTag(id)}
              disabled={disabled}
              aria-label={`Remove tag “${tagName.get(id) ?? id}” filter`}
              data-testid={`inventory-facet-tag-chip-${id}`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3"
            >
              {tagName.get(id) ?? id}
              <CloseIcon aria-hidden />
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
