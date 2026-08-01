import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Input,
  InputClearButton,
  LiveRegion,
  Modal,
  Tooltip,
  NAV_OPEN_DELAY_MS,
  resolveTabKey,
  useSearchEscapeToClear,
} from '@/components/foundry';
import { CheckIcon, SearchIcon } from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useAddCategoryField, useCreateCategory } from '../categories';
import {
  applyCategoryStarterSeed,
  categoryPresetMatches,
  CATEGORY_PRESETS,
  hasCategoryNamed,
  PRESET_SECTION_IDS,
  type CategoryPreset,
  type PresetSectionId,
} from '../category-presets';
import { FIELD_TYPE_LABELS } from './inventory-ui';

/** The translated label key for each browse section (typed, so a new section can't miss one). */
const SECTION_LABEL_KEY: Record<PresetSectionId, MessageKey> = {
  workshop: 'inventory.presets.section.workshop',
  electronics: 'inventory.presets.section.electronics',
  household: 'inventory.presets.section.household',
  containers: 'inventory.presets.section.containers',
  crafts: 'inventory.presets.section.crafts',
  media: 'inventory.presets.section.media',
  collectibles: 'inventory.presets.section.collectibles',
};

/** What the right-hand pane shows: the whole library (grouped) or a single section. */
type PresetScope = 'all' | PresetSectionId;

/** Rail order — the "All presets" entry then every section; also the arrow-key cycle. */
const RAIL_SCOPES: readonly PresetScope[] = ['all', ...PRESET_SECTION_IDS];

/**
 * The preset names of each section, comma-joined for the rail tooltips. The library is a
 * module constant, so this is computed once — never per render. (The names are the
 * preset registry's English data, exactly as the rows themselves show them.)
 */
const SECTION_PRESET_NAMES = Object.fromEntries(
  PRESET_SECTION_IDS.map((id) => [
    id,
    CATEGORY_PRESETS.filter((p) => p.sectionId === id)
      .map((p) => p.name)
      .join(', '),
  ]),
) as Record<PresetSectionId, string>;

/** How many field chips a row shows before collapsing the rest into a "+N more" chip. */
const ROW_FIELD_CHIP_LIMIT = 5;

/**
 * The preset library picker (redesigned per the browse-and-search request). A two-pane
 * dialog: the left side carries a search box above the browse sections ("All presets" +
 * one entry per {@link PRESET_SECTION_IDS}); the right side lists the presets of the
 * active scope as rows — each row the preset's name, description and a selection of the
 * custom fields it adds. On narrow screens the rail collapses to a horizontal chip row
 * above the list. Importing drives the ordinary create / add-field mutations; a preset
 * whose category already exists (case-insensitive) is marked "Added" and disabled, so
 * importing is idempotent and never makes a duplicate; a row whose own import is still
 * running holds on "Adding…" until the last of its fields has landed.
 *
 * Search matches across the whole library ({@link categoryPresetMatches}), so typing
 * hops the scope to "All presets" and the rail shows live per-section match counts.
 * The rail is one roving tab stop (Arrow/Home/End move + select, {@link resolveTabKey});
 * Escape follows the shared {@link useSearchEscapeToClear} seam — with a non-empty
 * search box focused it clears the filter, otherwise the enclosing {@link Modal} cancels.
 */
export function CategoryPresetPickerDialog({
  open,
  onClose,
  existingNames,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  existingNames: readonly string[];
  onImported: (categoryId: string) => void;
}) {
  const t = useT();
  const createCategory = useCreateCategory();
  const addField = useAddCategoryField();
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PresetScope>('all');
  const searchRef = useRef<HTMLInputElement>(null);
  // Roving-tabindex refs for the rail, so arrow-key movement can focus the new scope.
  const railRefs = useRef(new Map<PresetScope, HTMLButtonElement | null>());

  // The dialog component stays mounted between uses, so start each open afresh —
  // no stale filter, error, or half-browsed section from last time.
  useEffect(() => {
    if (open) {
      setQuery('');
      setScope('all');
      setImportError(null);
    }
  }, [open]);

  // Escape clears a focused, non-empty search box (and only then) — the shared
  // capture-phase seam; from an empty box it falls through to Modal, which cancels.
  useSearchEscapeToClear(open, searchRef, () => setQuery(''));

  const searching = query.trim().length > 0;
  const matching = useMemo(() => CATEGORY_PRESETS.filter((p) => categoryPresetMatches(p, query)), [query]);
  // One pass groups the matches; the rail counts and the grouped pane both read from it,
  // so the two can never disagree.
  const bySection = useMemo(() => {
    const groups = new Map<PresetSectionId, CategoryPreset[]>(PRESET_SECTION_IDS.map((id) => [id, []]));
    for (const preset of matching) groups.get(preset.sectionId)!.push(preset);
    return groups;
  }, [matching]);
  const sectionCount = (id: PresetSectionId) => bySection.get(id)!.length;
  const visible = scope === 'all' ? matching : bySection.get(scope)!;

  const changeQuery = (value: string) => {
    // Starting a search widens the scope to the whole library, so a match filed under
    // another section is never invisibly filtered out; narrowing again is one rail click.
    if (value.trim().length > 0 && query.trim().length === 0) setScope('all');
    setQuery(value);
  };

  const clearSearch = () => {
    setQuery('');
    searchRef.current?.focus();
  };

  const selectScope = (next: PresetScope) => {
    setScope(next);
    railRefs.current.get(next)?.focus();
  };

  // Arrow/Home/End move focus and selection together (the APG automatic-activation
  // model every rail in the app follows), so the rail is a single Tab stop.
  const onRailKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = resolveTabKey(RAIL_SCOPES, scope, event.key);
    if (next === null) return;
    event.preventDefault();
    selectScope(next as PresetScope);
  };

  const importPreset = (preset: CategoryPreset) => {
    setImportingId(preset.id);
    setImportError(null);
    void applyCategoryStarterSeed(preset.seed, {
      createCategory: (input) => createCategory.mutateAsync(input),
      addField: (categoryId, input) => addField.mutateAsync({ categoryId, input }),
    })
      .then(onImported)
      .catch((error: unknown) => {
        // Surface the failure in place (role="alert") — a silent revert of "Adding…"
        // would leave the user guessing whether anything was created.
        const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
        setImportError(t('inventory.presets.importFailed', { vars: { name: preset.name } }) + detail);
      })
      .finally(() => setImportingId(null));
  };

  const sectionLabel = (id: PresetSectionId) => t(SECTION_LABEL_KEY[id]);

  const railButtonProps = (target: PresetScope) => ({
    active: scope === target,
    tabIndex: scope === target ? 0 : -1,
    onKeyDown: onRailKeyDown,
    buttonRef: (el: HTMLButtonElement | null) => {
      railRefs.current.set(target, el);
    },
    onClick: () => setScope(target),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.presets.title')}
      description={t('inventory.presets.description')}
      className="max-w-3xl"
      scrollBody={false}
      initialFocusRef={searchRef}
      // The seed writes the category and then its fields one at a time, so a dismissal part-way
      // through leaves a partly-built category behind with nothing on screen to say so.
      busy={importingId !== null}
    >
      <div className="flex h-[65vh] min-h-0 flex-col gap-3 sm:flex-row sm:gap-4">
        {/* Left: the search box above the browse sections. On narrow screens the
            sections collapse to a horizontal chip row under the search box. */}
        <div className="flex shrink-0 flex-col gap-2 sm:w-52">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="text"
              aria-label={t('inventory.presets.search.label')}
              autoComplete="off"
              placeholder={t('inventory.presets.search.placeholder')}
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              className={cn('pl-9', query.length > 0 && 'pr-9')}
            />
            {query.length > 0 ? (
              <Tooltip
                content={t('inventory.presets.search.clearTooltip')}
                triggerTabIndex={-1}
                className="absolute right-1.5 top-1/2 -translate-y-1/2"
              >
                <InputClearButton label={t('inventory.presets.search.clear')} onClick={clearSearch} />
              </Tooltip>
            ) : null}
          </div>

          {/* Wrapping (not sideways-scrolling) chips on narrow screens: a scroll row's
              intrinsic width would propagate up and inflate the whole dialog past the
              viewport (grid-item min-width:auto), and wrapped chips need no hidden pan. */}
          <ul
            aria-label={t('inventory.presets.sections.label')}
            className="flex flex-wrap gap-1 sm:min-h-0 sm:flex-1 sm:flex-col sm:flex-nowrap sm:overflow-y-auto"
          >
            <li>
              <SectionButton
                label={t('inventory.presets.sections.all')}
                count={matching.length}
                dimmed={searching && matching.length === 0}
                tooltip={t('inventory.presets.sections.allTooltip')}
                ariaLabel={t('inventory.presets.section.aria', {
                  vars: { section: t('inventory.presets.sections.all'), count: matching.length },
                })}
                {...railButtonProps('all')}
              />
            </li>
            {PRESET_SECTION_IDS.map((id) => (
              <li key={id}>
                <SectionButton
                  label={sectionLabel(id)}
                  count={sectionCount(id)}
                  dimmed={searching && sectionCount(id) === 0}
                  tooltip={t('inventory.presets.section.tooltip', {
                    vars: { section: sectionLabel(id), presets: SECTION_PRESET_NAMES[id] },
                  })}
                  ariaLabel={t('inventory.presets.section.aria', {
                    vars: { section: sectionLabel(id), count: sectionCount(id) },
                  })}
                  {...railButtonProps(id)}
                />
              </li>
            ))}
          </ul>
        </div>

        {/* Right: the presets of the active scope, grouped by section when browsing All. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {importError ? (
            <p role="alert" className="mb-2 text-xs text-destructive">
              {importError}
            </p>
          ) : null}
          {/* Always-mounted region whose children change — the announce-reliable shape. */}
          <LiveRegion className={cn('text-xs text-muted-foreground', searching && 'mb-2')}>
            {searching ? (
              <p>
                {visible.length === 0
                  ? t(
                      scope === 'all'
                        ? 'inventory.presets.results.none'
                        : 'inventory.presets.results.sectionNone',
                      { vars: { query: query.trim() } },
                    )
                  : t('inventory.presets.results', { vars: { count: visible.length } })}
              </p>
            ) : null}
          </LiveRegion>
          <div className="min-h-0 flex-1 dialog-scroll">
            {scope === 'all' ? (
              PRESET_SECTION_IDS.map((id) => {
                const presets = bySection.get(id)!;
                if (presets.length === 0) return null;
                return (
                  <section key={id} className="mb-4 last:mb-0">
                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {sectionLabel(id)}
                    </h3>
                    <PresetRows
                      presets={presets}
                      existingNames={existingNames}
                      importingId={importingId}
                      onImport={importPreset}
                    />
                  </section>
                );
              })
            ) : (
              <PresetRows
                presets={visible}
                existingNames={existingNames}
                importingId={importingId}
                onImport={importPreset}
              />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** One entry of the sections rail: its label with a right-aligned live preset count. */
function SectionButton({
  label,
  count,
  active,
  dimmed,
  tooltip,
  ariaLabel,
  tabIndex,
  onClick,
  onKeyDown,
  buttonRef,
}: {
  label: string;
  count: number;
  active: boolean;
  /** Search is on and nothing in this section matches — kept clickable, but visibly quiet. */
  dimmed: boolean;
  tooltip: string;
  ariaLabel: string;
  /** Roving tabindex — only the active scope's button is tabbable; arrows move between them. */
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <Tooltip content={tooltip} triggerTabIndex={-1} openDelayMs={NAV_OPEN_DELAY_MS} className="w-full">
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-current={active ? 'true' : undefined}
        tabIndex={tabIndex}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
          active ? 'bg-primary/15 text-primary' : 'hover:bg-secondary',
          dimmed && 'opacity-50',
        )}
      >
        <span className="truncate">{label}</span>
        <span className={cn('shrink-0 text-xs', active ? 'text-primary/80' : 'text-muted-foreground')}>
          {count}
        </span>
      </button>
    </Tooltip>
  );
}

/** The list body shared by the grouped (All) and single-section views. */
function PresetRows({
  presets,
  existingNames,
  importingId,
  onImport,
}: {
  presets: readonly CategoryPreset[];
  existingNames: readonly string[];
  importingId: string | null;
  onImport: (preset: CategoryPreset) => void;
}) {
  return (
    <ul className="space-y-2">
      {presets.map((preset) => {
        const importing = importingId === preset.id;
        return (
          <li key={preset.id}>
            <PresetRow
              preset={preset}
              // A row in mid-import holds "Adding…" until its seed finishes. The seed writes
              // the category first and its fields one at a time afterwards, so `existingNames`
              // carries the name while those writes are still going; badging the row "Added"
              // on the name alone would claim the preset was in place against a category that
              // is only partly built.
              added={!importing && hasCategoryNamed(existingNames, preset.name)}
              importing={importing}
              disabled={importingId !== null}
              onImport={() => onImport(preset)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One importable preset: its name, live state (field count / Adding… / Added), description
 * and a selection of the custom fields it creates (the first {@link ROW_FIELD_CHIP_LIMIT},
 * then a "+N more" chip). The whole row is the import button.
 */
function PresetRow({
  preset,
  added,
  importing,
  disabled,
  onImport,
}: {
  preset: CategoryPreset;
  added: boolean;
  importing: boolean;
  disabled: boolean;
  onImport: () => void;
}) {
  const t = useT();
  const fieldCount = preset.seed.fields.length;
  const shownFields = preset.seed.fields.slice(0, ROW_FIELD_CHIP_LIMIT);
  const hiddenCount = fieldCount - shownFields.length;
  return (
    <Tooltip
      content={
        added
          ? t('inventory.presets.row.addedTooltip', { vars: { name: preset.name } })
          : t('inventory.presets.row.tooltip', { vars: { name: preset.name, count: fieldCount } })
      }
      triggerTabIndex={-1}
      className="w-full"
    >
      <button
        type="button"
        onClick={onImport}
        disabled={added || disabled}
        aria-label={t(added ? 'inventory.presets.row.addedAria' : 'inventory.presets.row.addAria', {
          vars: { name: preset.name },
        })}
        className="flex w-full flex-col gap-1.5 rounded-xl border border-border bg-secondary/20 p-3 text-left transition-colors enabled:hover:border-primary/40 enabled:hover:bg-secondary/40 disabled:cursor-default disabled:opacity-70"
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold">{preset.name}</span>
          {added ? (
            <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-glyph-success [&_svg]:size-3.5">
              <CheckIcon aria-hidden />
              {t('inventory.presets.row.added')}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              {importing
                ? t('inventory.presets.row.adding')
                : t('inventory.presets.row.fields', { vars: { count: fieldCount } })}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{preset.description}</span>
        <span className="flex flex-wrap gap-1">
          {shownFields.map((field) => (
            <span
              key={field.name}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs"
            >
              {field.name}
              <span className="text-muted-foreground">{FIELD_TYPE_LABELS[field.fieldType]}</span>
            </span>
          ))}
          {hiddenCount > 0 ? (
            <span className="inline-flex items-center rounded-md border border-transparent px-1.5 py-0.5 text-xs text-muted-foreground">
              {t('inventory.presets.row.moreFields', { vars: { count: hiddenCount } })}
            </span>
          ) : null}
        </span>
      </button>
    </Tooltip>
  );
}
