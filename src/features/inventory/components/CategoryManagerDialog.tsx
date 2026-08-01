import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Checkbox,
  EmojiPickerButton,
  FormField,
  Input,
  InfoHint,
  Modal,
  Radio,
  SelectField,
  Textarea,
  Tooltip,
  INFO_OPEN_DELAY_MS,
  type SelectOption,
} from '@/components/foundry';
import {
  AddIcon,
  CategoryIcon,
  ChevronDownIcon,
  CloseIcon,
  DeleteIcon,
  InfoIcon,
  WarningIcon,
} from '@/components/icons';
import {
  FIELD_DUE_LEAD_DAYS_DEFAULT,
  FIELD_DUE_LEAD_DAYS_MAX,
  FIELD_DUE_LEAD_DAYS_MIN,
  FIELD_PRECISION_MAX,
  FIELD_PRECISION_MIN,
  FIELD_TYPES,
  FIELD_UNIT_MAX_LENGTH,
  MAINTENANCE_BASES,
  TRACKING_MODES,
  type CategoryField,
  type CategoryLookupSource,
  type CategoryWithFieldCount,
  type Condition,
  type FieldType,
  type MaintenanceBasis,
  type TrackingMode,
  type UpdateCategoryFieldInput,
} from '@/db/repositories';
import { useT, type MessageKey, type TypedTranslator } from '@/features/i18n';
import {
  bindLookupOutputs,
  isBuiltinLookupTarget,
  LOOKUP_PROVIDERS,
  type BindableField,
  type BuiltinLookupTarget,
  type LookupOutputDef,
  type LookupProvider,
} from '@/features/lookups';
import type { FeatureId } from '@/features/modules/feature-registry';
import { usePreferencesStore, type AttachmentMode } from '@/state/stores/usePreferencesStore';
import { clampFieldDueLeadDays } from '@/features/lifecycle/field-due';
import { cn } from '@/lib/utils';
import { builtInFieldNameClash } from '../builtin-field-names';
import { isKeyField, KEY_FIELD_PROMINENCE } from '../field-def-prominence';
import { HIDEABLE_CAPABILITIES, toggleHiddenCapability } from '../category-capabilities';
import {
  FIELD_PROMINENCE_MODES,
  MAX_FIELD_TAB_LABEL_LENGTH,
  toFieldProminenceMode,
  type FieldProminenceMode,
} from '../field-prominence';
import {
  useAddCategoryField,
  useCategories,
  useCategoryFields,
  useCreateCategory,
  useDeleteCategory,
  useDeleteCategoryField,
  useDeleteUnusedFieldDef,
  useUnusedFieldDefs,
  useUpdateCategory,
  useUpdateCategoryField,
} from '../categories';
import { CategoryPresetPickerDialog } from './CategoryPresetPicker';
import {
  ATTACHMENT_MODE_LABELS,
  conditionSelectOptions,
  FIELD_TYPE_LABELS,
  MAINTENANCE_BASIS_LABELS,
  TRACKING_MODE_LABELS,
} from './inventory-ui';
import { TypedFieldControl } from './TypedFieldControl';
import { useErrorMessage, useReportWriteFailure } from '@/features/errors';

/**
 * Category & schema manager (spec §4). Create categories, define their dynamic
 * custom fields, and configure the global datasheet-linking mode (Option A/B).
 */
export function CategoryManagerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Categories & schemas"
      description="Group items into categories, and give each one a custom schema of extra fields."
      className="max-w-3xl"
    >
      <p className="mb-4 text-xs text-muted-foreground">
        A category is a label you assign to items (e.g. "Cables", "Fasteners"). Its
        <span className="font-medium text-foreground"> schema</span> is the set of custom fields you add below
        — say, <span className="font-medium text-foreground">Voltage</span> or{' '}
        <span className="font-medium text-foreground">Warranty expiry</span> — which then appear on every item
        in that category, alongside the built-in fields every item already has. Nothing here is required:
        items without a category just skip this step.
      </p>
      <CategoryManagerBody />
      <UnusedFieldsSection />
      <DatasheetLinkingConfig />
    </Modal>
  );
}

/**
 * The leftovers of the shared field dictionary: definitions no category, location or item
 * refers to any more.
 *
 * Removing a field from a category deliberately keeps its *definition* — the dictionary is
 * vocabulary shared across every category and location, so destroying it on the last
 * category's say-so would take other people's fields with it. What that leaves behind is a
 * definition with no users, cluttering every "Add a field" picker with no way to be rid of
 * it. This is that way: it lists only the genuinely unreferenced ones, so removing one can
 * never take a value with it, and it hides itself entirely when there is nothing to clean up.
 */
function UnusedFieldsSection() {
  const t = useT();
  const { data: unused } = useUnusedFieldDefs();
  const remove = useDeleteUnusedFieldDef();

  if (!unused || unused.length === 0) return null;

  return (
    <section className="mt-5 rounded-xl border border-border bg-secondary/10 p-3">
      <h3 className="mb-field-gap-compact flex items-center gap-1.5 text-sm font-semibold">
        {t('inventory.fields.unused.title')}
        <InfoHint content={t('inventory.fields.unused.hint')} />
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {unused.map((def) => (
          <li
            key={def.id}
            className="flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-secondary/20 px-2.5 py-1 text-sm"
          >
            {/* `min-w-0` is what lets the name actually shrink: a flex item defaults to its
                content's width, so `truncate` alone would never engage and a long field name
                would push the chip past the section instead of ellipsising. */}
            <span className="min-w-0 truncate">{def.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{FIELD_TYPE_LABELS[def.fieldType]}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-5 [&_svg]:size-3.5"
              aria-label={t('inventory.fields.unused.remove', { vars: { name: def.name } })}
              disabled={remove.isPending && remove.variables === def.id}
              onClick={() => remove.mutate(def.id)}
            >
              <CloseIcon className="text-glyph-danger" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CategoryManagerBody() {
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  // `useCreateCategory` has no hook-level reporter (the preset importer surfaces its own errors),
  // so this fire-and-forget create reports its own failure (#389).
  const reportCreateFailure = useReportWriteFailure(
    'inventory.writeError.heading.categoryCreate',
    'common.writeFailed',
  );
  const [newName, setNewName] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = categories?.rows ?? [];
  const selected = rows.find((c) => c.id === selectedId) ?? null;

  const addCategory = () => {
    const name = newName.trim();
    if (!name) return;
    createCategory.mutate(
      { name },
      { onSuccess: (cat) => setSelectedId(cat.id), onError: reportCreateFailure },
    );
    setNewName('');
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_1fr]">
      {/* Category list */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCategory())}
            placeholder="New category…"
            aria-label="New category name"
            className="flex-1"
          />
          <InfoHint content="A category is a label you assign to items — e.g. **Cables**, **Fasteners** — so you can give its members their own custom fields on the right." />
          <Tooltip
            content="Create the category, then define its custom fields on the right."
            triggerTabIndex={-1}
          >
            <span>
              <Button size="icon" aria-label="Add category" onClick={addCategory} disabled={!newName.trim()}>
                <AddIcon />
              </Button>
            </span>
          </Tooltip>
        </div>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-1 py-2 text-xs text-muted-foreground">No categories yet.</li>
          ) : (
            rows.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(cat.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                    cat.id === selectedId ? 'bg-primary/15 text-primary' : 'hover:bg-secondary'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {cat.glyph ? (
                      <span aria-hidden className="shrink-0 leading-none">
                        {cat.glyph}
                      </span>
                    ) : null}
                    <span className="truncate">{cat.name}</span>
                  </span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">{cat.fieldCount}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <PresetPickerButton existingNames={rows.map((c) => c.name)} onImported={(id) => setSelectedId(id)} />
      </div>

      {/* Selected category detail */}
      <div className="min-w-0">
        {selected ? (
          <CategoryDetail
            category={selected}
            onDeleted={() => {
              deleteCategory.mutate(selected.id);
              setSelectedId(null);
            }}
          />
        ) : (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            Select a category to edit its fields.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * "Add from a preset" affordance (backlog T4, generalised). Opens the
 * {@link CategoryPresetPickerDialog} — a browsable, searchable library of ready-made schemas a
 * user can import to give a set of items common custom fields in one step, instead of
 * hand-assembling each field. Each import runs through the ordinary create-category / add-field
 * mutation path (no bespoke repository method), so the result is a plain category whose fields
 * propagate to every item using it.
 */
function PresetPickerButton({
  existingNames,
  onImported,
}: {
  existingNames: readonly string[];
  onImported: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <>
      <Tooltip content={t('inventory.presets.openTooltip')} triggerTabIndex={-1}>
        <span className="block">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setOpen(true)}>
            <CategoryIcon />
            {t('inventory.presets.open')}
          </Button>
        </span>
      </Tooltip>
      {/* Opened only on click, so this nested dialog always mounts after its parent (modal-stack seam). */}
      <CategoryPresetPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        existingNames={existingNames}
        onImported={(id) => {
          setOpen(false);
          onImported(id);
        }}
      />
    </>
  );
}

function CategoryDetail({
  category,
  onDeleted,
}: {
  category: CategoryWithFieldCount;
  onDeleted: () => void;
}) {
  const { data: fields } = useCategoryFields(category.id);
  const deleteField = useDeleteCategoryField();
  const updateCategory = useUpdateCategory();
  // One draft for the hidden-capability set, shared by the two panels that write it. See
  // {@link useHiddenCapabilitiesDraft} for why it cannot live inside either of them.
  const hiddenCapabilities = useHiddenCapabilitiesDraft(category);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold">
          {category.glyph ? (
            <span aria-hidden className="shrink-0 leading-none">
              {category.glyph}
            </span>
          ) : null}
          <span className="truncate">{category.name}</span>
        </h3>
        <Tooltip
          content="Delete this category and all its field definitions. Items keep their stored values."
          triggerTabIndex={-1}
        >
          <span>
            <Button variant="ghost" size="icon" aria-label="Delete category" onClick={onDeleted}>
              <DeleteIcon className="text-glyph-danger" />
            </Button>
          </span>
        </Tooltip>
      </div>

      {/* Optional decorative glyph (issue #83) — a plain LWW column, so it auto-saves the moment
          it changes, mirroring the defaults editor below. Shown as a faint greyscale watermark on
          items' Visual cards (when the global card-watermark setting is on). */}
      <FormField
        label="Glyph"
        hint={
          'An optional emoji shown as a faint **watermark** on the Visual cards of items in this ' +
          'category — e.g. 🔋 for batteries, 📖 for books. Pick one from the glyph browser, or ' +
          'clear it for none. Purely decorative; you can turn all category watermarks off in ' +
          '**Settings → Inventory → Item cards**.'
        }
      >
        <EmojiPickerButton
          value={category.glyph}
          onChange={(glyph) => updateCategory.mutate({ id: category.id, input: { glyph } })}
          clearable
          placeholder="No glyph"
          aria-label="Choose category glyph"
          clearLabel="Remove category glyph"
          title="Choose a category glyph"
        />
      </FormField>

      <ul className="space-y-1">
        {(fields ?? []).length === 0 ? (
          <li className="text-xs text-muted-foreground">No fields. Add one below.</li>
        ) : (
          fields!.map((field) => (
            <li
              key={field.id}
              className="rounded-lg border border-border bg-secondary/20 px-2.5 py-1.5 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate">
                  {field.name}
                  {field.isRequired ? <span className="text-destructive"> *</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {FIELD_TYPE_LABELS[field.fieldType]}
                </span>
                <button
                  type="button"
                  aria-label={`Remove field ${field.name}`}
                  onClick={() => deleteField.mutate(field.id)}
                  className="rounded p-0.5 transition-colors hover:bg-secondary [&_svg]:size-3.5"
                >
                  <CloseIcon className="text-glyph-danger" />
                </button>
              </div>
              {/* Unlike the two below, this one is on every field: a unit means nothing on a date
                  and a notice period means nothing on a number, but any type can be the field that
                  matters most. */}
              <FieldKeyControl field={field} />
              {/* Only a date can be a deadline, so the control appears on nothing else. It sits
                  on the *existing* field rather than only on the add form because a date field is
                  usually already there by the time its deadline-ness matters — the preset library
                  ships several, and a field added before this existed has no other way back. */}
              {field.fieldType === 'DATE' ? <FieldDueDateControl field={field} /> : null}
              {/* Likewise a unit and a range belong to a number and nothing else, and they sit
                  on the existing field for the same reason: the preset library ships plenty of
                  number fields, and one added before this existed has no other way back. */}
              {field.fieldType === 'NUMBER' ? <FieldNumberOptionsControl field={field} /> : null}
            </li>
          ))
        )}
      </ul>

      <AddFieldForm categoryId={category.id} />

      <CategoryDefaultsSection category={category} />

      <CategoryHiddenSectionsPanel category={category} hiddenCapabilities={hiddenCapabilities} />

      <CategoryFieldProminencePanel category={category} hiddenCapabilities={hiddenCapabilities} />

      {/* `fields` is passed through undefined-and-all: the panel must be able to tell "not loaded
          yet" from "this category has none", because binding treats the two identically. */}
      <CategoryLookupSourcesPanel category={category} fields={fields} />
    </div>
  );
}

/**
 * The category's hidden-capability set as a single **shared draft** — the base every panel that
 * writes that column computes from.
 *
 * The column holds a *set*, so each change is a read-modify-write of the whole value, and
 * `useUpdateCategory` is not optimistic (it only invalidates on settle). Computing the next value
 * from the query cache therefore loses changes: a second edit made before the refetch lands
 * recomputes from the pre-first-edit array and silently drops it — and because the column syncs
 * LWW, that discard reaches other devices.
 *
 * A per-panel draft fixes that only while one panel writes the column. Two do — the hidden-sections
 * checkboxes and the prominence panel's "show the custom fields again" fix (issue #619) — and a
 * second, independent draft reintroduces the same bug across panels *and* adds a worse one: the
 * drafts only reseed when a different category is selected, so after one panel writes, the other
 * renders stale state for the rest of the session and writes its own value back over the change.
 * Hence one draft, owned by the parent that renders both.
 */
function useHiddenCapabilitiesDraft(category: CategoryWithFieldCount): HiddenCapabilitiesDraft {
  const updateCategory = useUpdateCategory();
  const [draft, setDraft] = useState<readonly string[]>(category.hiddenCapabilities);
  const seededFor = useRef(category.id);
  useEffect(() => {
    if (seededFor.current !== category.id) {
      seededFor.current = category.id;
      setDraft(category.hiddenCapabilities);
    }
  }, [category.id, category.hiddenCapabilities]);

  return {
    hidden: new Set(draft),
    setCapabilityHidden: (id: FeatureId, hide: boolean) => {
      const next = toggleHiddenCapability(draft, id, hide);
      setDraft(next);
      updateCategory.mutate({ id: category.id, input: { hiddenCapabilities: next } });
    },
  };
}

/** The shared draft's public shape: what is hidden right now, and the one way to change it. */
interface HiddenCapabilitiesDraft {
  readonly hidden: ReadonlySet<string>;
  readonly setCapabilityHidden: (id: FeatureId, hide: boolean) => void;
}

/**
 * Where this category's custom fields sit on an item (issue #619).
 *
 * Its own box rather than a row inside "Sections these items don't need", because the two answer
 * opposite questions: that one removes things this kind of item doesn't have, this one *raises*
 * something it is largely defined by. Folding a promotion into a panel headed "don't need" would
 * read as the reverse of what it does.
 *
 * Saving is immediate, like every other control in this dialog. The radio group needs no buffer —
 * a mode is never transiently invalid — but the tab label is free text, so it keeps one, reset
 * when a different category is selected.
 */
function CategoryFieldProminencePanel({
  category,
  hiddenCapabilities,
}: {
  category: CategoryWithFieldCount;
  hiddenCapabilities: HiddenCapabilitiesDraft;
}) {
  const t = useT();
  const updateCategory = useUpdateCategory();
  const mode = toFieldProminenceMode(category.fieldProminence);

  const [labelText, setLabelText] = useState(category.fieldTabLabel ?? '');
  const seededFor = useRef(category.id);
  useEffect(() => {
    if (seededFor.current !== category.id) {
      seededFor.current = category.id;
      setLabelText(category.fieldTabLabel ?? '');
    }
  }, [category.id, category.fieldTabLabel]);

  // Promoting the fields while the category also hides them is a contradiction the user can
  // reach from two directions, so say so and offer the fix rather than silently letting one
  // decision win. Mirrors the maintenance conflict above. Read through the shared draft, not the
  // query cache, so the banner agrees with the checkbox above it the moment either is changed.
  const conflict = hiddenCapabilities.hidden.has('custom-fields') && mode !== 'default';

  // `name` is scoped to the category so two rendered panels could never share a radio group —
  // the browser's mutual exclusion is keyed on the name, not on the DOM subtree.
  const groupName = `category-field-prominence-${category.id}`;

  return (
    <fieldset className="space-y-field-gap-compact rounded-lg border border-border bg-secondary/10 p-2.5">
      {/* As in the panel above, the legend *is* the visible heading — a sr-only legend beside an
          identical <h4> would name the group twice to a screen reader for no visual gain. */}
      <legend className="flex items-center gap-1.5 text-sm font-semibold">
        {t('category.fieldProminence.title')}
        <InfoHint content={t('category.fieldProminence.hint')} />
      </legend>
      <p className="text-xs text-muted-foreground">{t('category.fieldProminence.blurb')}</p>

      <div className="space-y-1">
        {FIELD_PROMINENCE_MODES.map((option) => (
          // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested radio is correctly associated; the label's text comes from the translation catalog, which the linter cannot resolve to a static string.
          <label
            key={option}
            className="flex cursor-pointer items-start gap-3 rounded-md p-1.5 hover:bg-secondary/40"
          >
            <Radio
              name={groupName}
              checked={mode === option}
              onChange={() => updateCategory.mutate({ id: category.id, input: { fieldProminence: option } })}
              className="mt-0.5"
              data-testid={`category-field-prominence-${option}`}
            />
            <span className="flex-1">
              <span className="block text-xs font-medium">{t(FIELD_PROMINENCE_LABEL_KEYS[option])}</span>
              <span className="block text-xs text-muted-foreground">
                {t(FIELD_PROMINENCE_DESCRIPTION_KEYS[option])}
              </span>
            </span>
          </label>
        ))}
      </div>

      {/* Only the break-out mode has a tab to name, so the field appears with it rather than
          sitting permanently disabled. The stored label survives a switch away and back — the
          repository keeps the column — so nothing typed here is lost by changing your mind. */}
      {mode === 'own-tab' ? (
        <FormField
          label={t('category.fieldProminence.tabLabel')}
          hint={t('category.fieldProminence.tabLabelHint')}
        >
          <Input
            value={labelText}
            // HTML `maxLength` counts UTF-16 code units where the seam caps by code point, so the
            // browser stops an emoji-heavy label slightly sooner than storage would. Deliberate:
            // for all but a label of a dozen-plus emoji the two agree, and a cap the user can feel
            // while typing beats one that silently truncates what they typed on save.
            maxLength={MAX_FIELD_TAB_LABEL_LENGTH}
            placeholder={t('item.tab.customFields')}
            data-testid="category-field-tab-label"
            onChange={(e) => {
              setLabelText(e.target.value);
              updateCategory.mutate({ id: category.id, input: { fieldTabLabel: e.target.value } });
            }}
          />
        </FormField>
      ) : null}

      {conflict ? (
        <Banner
          tone="warning"
          icon={<WarningIcon aria-hidden />}
          action={
            <Button
              size="sm"
              variant="ghost"
              data-testid="category-field-prominence-conflict-clear"
              // Un-hide rather than drop the position: asking for the fields to come forward is
              // the choice the user made in *this* panel, so the other half of the contradiction
              // is the one to give way. Goes through the shared draft so the checkbox above
              // follows, and so a tick made moments earlier is not recomputed away.
              onClick={() => hiddenCapabilities.setCapabilityHidden('custom-fields', false)}
            >
              {t('category.fieldProminence.conflictAction')}
            </Button>
          }
        >
          {t('category.fieldProminence.conflict')}
        </Banner>
      ) : null}
    </fieldset>
  );
}

/** The radio labels, keyed by mode so a new mode is a compile error until it has copy. */
const FIELD_PROMINENCE_LABEL_KEYS = {
  default: 'category.fieldProminence.option.default',
  promoted: 'category.fieldProminence.option.promoted',
  'own-tab': 'category.fieldProminence.option.ownTab',
} as const satisfies Record<FieldProminenceMode, MessageKey>;

/** The one-line explanation under each radio, keyed the same way. */
const FIELD_PROMINENCE_DESCRIPTION_KEYS = {
  default: 'category.fieldProminence.option.defaultHint',
  promoted: 'category.fieldProminence.option.promotedHint',
  'own-tab': 'category.fieldProminence.option.ownTabHint',
} as const satisfies Record<FieldProminenceMode, MessageKey>;

/**
 * Which sections this category's items don't need (issue #618).
 *
 * Deliberately a separate box from "Defaults for new items": those pre-fill a *new* item and
 * never touch existing ones, whereas this changes what **every** item in the category shows,
 * now and in future. Presenting them together would imply the wrong scope.
 *
 * Ticking hides — the question is "what doesn't this kind of thing have?", which is the way
 * round a user thinks about a Movie having no service schedule. Saving is immediate, matching
 * every other control in this dialog.
 *
 * The set itself is **not** owned here: it lives in the shared {@link useHiddenCapabilitiesDraft}
 * one level up, because the prominence panel below writes the same column.
 */
function CategoryHiddenSectionsPanel({
  category,
  hiddenCapabilities,
}: {
  category: CategoryWithFieldCount;
  hiddenCapabilities: HiddenCapabilitiesDraft;
}) {
  const t = useT();
  const updateCategory = useUpdateCategory();
  const { hidden, setCapabilityHidden: toggle } = hiddenCapabilities;

  // A category that both *applies* a maintenance schedule to every new item and hides the
  // section showing it would be quietly contradictory — the schedule would be created and then
  // made invisible. Rather than silently dropping either half of the user's stated intent, say
  // so and offer the fix; clearing stored configuration behind their back would be worse.
  const maintenanceConflict = hidden.has('maintenance') && category.defaultMaintenanceBasis !== null;

  return (
    <fieldset className="space-y-field-gap-compact rounded-lg border border-border bg-secondary/10 p-2.5">
      {/* The legend *is* the visible heading: a sr-only legend beside an identical <h4> would
          name the group twice to a screen reader for no visual gain. */}
      <legend className="flex items-center gap-1.5 text-sm font-semibold">
        {t('category.hiddenSections.title')}
        <InfoHint content={t('category.hiddenSections.hint')} />
      </legend>
      <p className="text-xs text-muted-foreground">{t('category.hiddenSections.blurb')}</p>

      <div className="space-y-1">
        {HIDEABLE_CAPABILITIES.map((feature) => (
          // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested checkbox is correctly associated; the label's text is the feature's registry name, which the linter cannot resolve to a static string.
          <label
            key={feature.id}
            className="flex cursor-pointer items-start gap-3 rounded-md p-1.5 hover:bg-secondary/40"
          >
            <Checkbox
              checked={hidden.has(feature.id)}
              onChange={(e) => toggle(feature.id, e.target.checked)}
              className="mt-0.5"
              data-testid={`category-hide-${feature.id}`}
            />
            <span className="flex-1">
              <span className="block text-xs font-medium">{feature.label}</span>
              <span className="block text-xs text-muted-foreground">{feature.description}</span>
            </span>
          </label>
        ))}
      </div>

      {maintenanceConflict ? (
        <Banner
          tone="warning"
          icon={<WarningIcon aria-hidden />}
          action={
            <Button
              size="sm"
              variant="ghost"
              data-testid="category-hide-maintenance-conflict-clear"
              onClick={() =>
                updateCategory.mutate({
                  id: category.id,
                  input: {
                    defaultMaintenanceBasis: null,
                    defaultMaintenanceIntervalDays: null,
                    defaultMaintenanceIntervalUsage: null,
                  },
                })
              }
            >
              {t('category.hiddenSections.maintenanceConflictAction')}
            </Button>
          }
        >
          {t('category.hiddenSections.maintenanceConflict')}
        </Banner>
      ) : null}
    </fieldset>
  );
}

/**
 * The copy naming each reserved built-in item attribute a lookup value can be pointed at.
 *
 * Keyed by target id so a built-in added to the seam is a compile error here until it has a
 * label, rather than quietly rendering its raw `builtin:` id to the user.
 */
const BUILTIN_TARGET_LABEL_KEYS = {
  'builtin:name': 'lookup.builtin.name',
  'builtin:description': 'lookup.builtin.description',
} as const satisfies Record<BuiltinLookupTarget, MessageKey>;

/** A lookup target's user-facing name: a built-in's translated label, or the field's own name. */
function lookupTargetLabel(t: TypedTranslator, target: string): string {
  return isBuiltinLookupTarget(target) ? t(BUILTIN_TARGET_LABEL_KEYS[target]) : target;
}

/**
 * The built-in attributes offered as an override target for an output key of this type.
 *
 * Type-gated here rather than offered universally, because the binder cannot do it: an explicit
 * map entry naming a built-in is authoritative and type-checked against nothing (a built-in has
 * no declared type to mismatch). Without this guard the picker would cheerfully offer to write a
 * runtime in minutes into the item's description.
 */
function builtinTargetsFor(type: FieldType): readonly BuiltinLookupTarget[] {
  if (type === 'TEXT') return ['builtin:name'];
  if (type === 'LONG_TEXT') return ['builtin:description'];
  return [];
}

/**
 * The field map with one output key pointed at `target`, or with its override dropped when
 * `target` is blank (back to the run-time name match).
 *
 * An emptied map collapses to `null` rather than `{}` so "no overrides at all" has exactly one
 * stored spelling — the repository canonicalises the same way, and an LWW sync must not read a
 * write as an edit when the user has changed nothing.
 */
function withLookupTarget(
  fieldMap: Readonly<Record<string, string>> | null,
  outputKey: string,
  target: string,
): Readonly<Record<string, string>> | null {
  const next = { ...(fieldMap ?? {}) };
  if (target === '') delete next[outputKey];
  else next[outputKey] = target;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * "Fill from an open database" — which curated open databases this category's fields can be
 * filled from (issue #616, phase L2).
 *
 * The one place a provider becomes reachable: everything below it — the search, the match picker,
 * the review dialog — renders only for an item whose category has a provider attached here.
 * Nothing in the mechanism knows the word "Movie"; the binding is category-id → provider-id, so a
 * user's own "Films I own" category attaches the same provider and a renamed category keeps it.
 *
 * Saving is immediate, like every other control in this dialog.
 */
function CategoryLookupSourcesPanel({
  category,
  fields,
}: {
  category: CategoryWithFieldCount;
  /**
   * The category's fields, or `undefined` while they are still arriving (or could not be read).
   *
   * Deliberately **not** defaulted to `[]` by the caller: an empty list and an unknown one bind
   * identically through `bindLookupOutputs`, so collapsing the two would make a category that
   * binds every value perfectly report all of them as having nowhere to go, for as long as the
   * query is in flight. The sibling `CategoryLookupPanel` refuses to resolve a binding in that
   * state for exactly the same reason.
   */
  fields: readonly CategoryField[] | undefined;
}) {
  const t = useT();
  const updateCategory = useUpdateCategory();

  // The column holds a *list*, so every change is a read-modify-write of the whole value, and
  // `useUpdateCategory` is not optimistic (it only invalidates on settle) — recomputing the next
  // value from the query cache would silently drop a second change made before the refetch lands,
  // and because the column syncs LWW that discard would reach other devices. Unlike
  // `hiddenCapabilities`, this column has exactly one writer, so the draft can live here rather
  // than one level up.
  const [draft, setDraft] = useState<readonly CategoryLookupSource[]>(category.lookupSources);
  const seededFor = useRef(category.id);
  useEffect(() => {
    if (seededFor.current !== category.id) {
      seededFor.current = category.id;
      setDraft(category.lookupSources);
    }
  }, [category.id, category.lookupSources]);

  const save = (next: readonly CategoryLookupSource[]) => {
    setDraft(next);
    updateCategory.mutate({ id: category.id, input: { lookupSources: next } });
  };

  // `BindableField` is the narrow shape the pure binder takes; a category field satisfies it
  // structurally, so this trims rather than reshapes. Stays null until the fields are known — see
  // the `fields` prop.
  const bindable = useMemo<readonly BindableField[] | null>(
    () =>
      fields?.map((f) => ({ id: f.id, name: f.name, fieldType: f.fieldType, options: f.options })) ?? null,
    [fields],
  );

  /**
   * Attach or detach a provider, leaving every other stored entry — **including one this build
   * doesn't recognise** — exactly as it was. A provider id written by a peer on a newer version
   * has to survive a round-trip through this picker, which is why the draft is filtered rather
   * than rebuilt from the registry.
   */
  const setAttached = (providerId: string, attached: boolean) => {
    if (!attached) {
      save(draft.filter((source) => source.providerId !== providerId));
      return;
    }
    if (draft.some((source) => source.providerId === providerId)) return;
    save([...draft, { providerId, fieldMap: null }]);
  };

  return (
    <fieldset className="space-y-field-gap-compact rounded-lg border border-border bg-secondary/10 p-2.5">
      {/* As in the panels above, the legend *is* the visible heading — a sr-only legend beside an
          identical <h4> would name the group twice to a screen reader for no visual gain. */}
      <legend className="flex items-center gap-1.5 text-sm font-semibold">
        {t('category.lookupSources.title')}
        <InfoHint content={t('category.lookupSources.hint')} />
      </legend>
      <p className="text-xs text-muted-foreground">{t('category.lookupSources.blurb')}</p>

      <div className="space-y-1">
        {LOOKUP_PROVIDERS.map((provider) => {
          const attached = draft.find((source) => source.providerId === provider.id) ?? null;
          return (
            <div key={provider.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-md p-1.5 hover:bg-secondary/40">
                <Checkbox
                  checked={attached !== null}
                  onChange={(e) => setAttached(provider.id, e.target.checked)}
                  className="mt-0.5"
                  data-testid={`category-lookup-${provider.id}`}
                />
                <span className="flex-1">
                  <span className="block text-xs font-medium">{provider.sourceName}</span>
                  {/* Derived from the provider's own outputs rather than a hand-written blurb per
                      provider: one less parallel list to drift, and it names exactly what this
                      build would fill. */}
                  <span className="block text-xs text-muted-foreground">
                    {t('category.lookupSources.fills', {
                      vars: {
                        fields: provider.outputs
                          .map((output) => lookupTargetLabel(t, output.defaultTarget))
                          .join(', '),
                      },
                    })}
                  </span>
                </span>
              </label>
              {attached === null ? null : bindable === null ? (
                // Say the fields aren't known yet rather than resolving against none of them: every
                // value would report as having nowhere to go, on a category where they all land.
                <p className="ml-7 text-xs text-muted-foreground" data-testid="category-lookup-loading">
                  {t('lookup.panel.loading')}
                </p>
              ) : (
                <LookupFieldMapEditor
                  provider={provider}
                  fieldMap={attached.fieldMap}
                  fields={bindable}
                  onChangeTarget={(outputKey, target) =>
                    save(
                      draft.map((source) =>
                        source.providerId === provider.id
                          ? { ...source, fieldMap: withLookupTarget(source.fieldMap, outputKey, target) }
                          : source,
                      ),
                    )
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * "Where each value goes" — the per-output-key override for one attached provider.
 *
 * This is the *second* of the binder's two layers. The first matches each value's default field
 * name against the category's own fields at run time, and covers an untouched preset category with
 * no configuration at all; this is the way back for a category whose field has since been renamed
 * or re-purposed, which otherwise has no way to fix a value reported as having nowhere to go.
 *
 * Collapsed by default, because the common case needs nothing here — but the *problem* summary
 * sits outside the collapse, so a value with nowhere to land is never hidden behind a toggle.
 */
function LookupFieldMapEditor({
  provider,
  fieldMap,
  fields,
  onChangeTarget,
}: {
  provider: LookupProvider;
  fieldMap: Readonly<Record<string, string>> | null;
  fields: readonly BindableField[];
  onChangeTarget: (outputKey: string, target: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Two resolutions, deliberately. The *effective* one — overrides applied — is what the summary
  // must count, since that is what a lookup would actually do. The unmapped one is what each key's
  // "Match by name" option would do if chosen, which is what that option has to name; reading it
  // off the effective binding would make the option describe the override it replaces.
  const effective = useMemo(
    () => bindLookupOutputs(provider.outputs, fields, fieldMap),
    [provider, fields, fieldMap],
  );
  const byName = useMemo(() => bindLookupOutputs(provider.outputs, fields, null), [provider, fields]);
  const autoTarget = useMemo(
    () => new Map(byName.bindings.map((binding) => [binding.outputKey, binding.targetName])),
    [byName],
  );
  const autoProblem = useMemo(
    () => new Map(byName.problems.map((problem) => [problem.outputKey, problem])),
    [byName],
  );

  /** What "Match by name" would do for this key — named, so choosing it is never a leap of faith. */
  const autoLabel = (output: LookupOutputDef): string => {
    const bound = autoTarget.get(output.key);
    if (bound !== undefined) {
      return t('category.lookupSources.autoBound', { vars: { name: lookupTargetLabel(t, bound) } });
    }
    const problem = autoProblem.get(output.key);
    return problem !== undefined && problem.kind === 'TYPE_MISMATCH'
      ? t('category.lookupSources.autoMismatch', { vars: { name: problem.wantedName } })
      : t('category.lookupSources.autoUnbound', {
          vars: { name: lookupTargetLabel(t, output.defaultTarget) },
        });
  };

  /**
   * The target this key is pointed at **right now** — `''` for the run-time name match.
   *
   * A stored id naming a field the category no longer has reads as `''`, because that is exactly
   * what it does: `bindLookupOutputs` falls back to the name match for a map entry it cannot
   * resolve rather than failing on it (see `binding.ts`). Showing the dangling id instead would
   * tell the user a value is broken while it is landing perfectly well.
   */
  const storedTarget = (output: LookupOutputDef): string => {
    const stored = fieldMap?.[output.key];
    if (stored === undefined) return '';
    if (isBuiltinLookupTarget(stored)) return stored;
    return fields.some((field) => field.id === stored) ? stored : '';
  };

  const optionsFor = (output: LookupOutputDef): readonly SelectOption[] => {
    const options: SelectOption[] = [
      { value: '', label: autoLabel(output) },
      // Only fields of the value's own type: a mismatch is something the binder *reports* rather
      // than coerces, so offering one here would be offering the user a way to break their own
      // lookup.
      ...fields
        .filter((field) => field.fieldType === output.type)
        .map((field) => ({ value: field.id, label: field.name })),
      ...builtinTargetsFor(output.type).map((target) => ({
        value: target,
        label: lookupTargetLabel(t, target),
      })),
    ];
    // A field can be *retyped* after being chosen, which the filter above then hides — but the
    // binder still honours the entry and reports the mismatch, so the choice has to stay visible
    // and marked. (A stored id whose field is gone never reaches here: `storedTarget` already
    // reads it as the name match, which is what the binder does with it.)
    const current = storedTarget(output);
    if (current !== '' && !options.some((option) => option.value === current)) {
      // `storedTarget` only yields a built-in or a field that exists, so "no field" means the
      // former — a built-in this build wouldn't offer for this value's type, written by a peer on
      // a newer version. The binder treats an explicit built-in entry as authoritative, so it is
      // genuinely in force and must be shown rather than dropped from the list.
      const field = fields.find((candidate) => candidate.id === current);
      options.push({
        value: current,
        label:
          field === undefined
            ? lookupTargetLabel(t, current)
            : t('category.lookupSources.wrongType', { vars: { name: field.name } }),
      });
    }
    return options;
  };

  return (
    <div className="ml-7 space-y-field-gap-compact">
      {effective.problems.length > 0 ? (
        <Banner
          tone="warning"
          icon={<WarningIcon aria-hidden />}
          role="status"
          className="text-xs"
          data-testid={`category-lookup-problems-${provider.id}`}
        >
          {t('category.lookupSources.problems', { vars: { count: effective.problems.length } })}
        </Banner>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        data-testid={`category-lookup-map-toggle-${provider.id}`}
      >
        {t('category.lookupSources.mapping')}
        <ChevronDownIcon
          aria-hidden
          className={cn('transition-transform ease-emphasized', open && 'rotate-180')}
        />
      </Button>
      {open ? (
        <div id={panelId} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {provider.outputs.map((output) => (
            <SelectField
              key={output.key}
              label={lookupTargetLabel(t, output.defaultTarget)}
              value={storedTarget(output)}
              onChange={(target) => onChangeTarget(output.key, target)}
              options={optionsFor(output)}
              data-testid={`category-lookup-target-${provider.id}-${output.key}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Seed interval offered the moment a maintenance basis is first chosen (backlog T2a), so a
 * freshly-picked basis is immediately effective rather than a silent no-op — the user can still
 * edit or clear it. A year for TIME (matching the "annual calibration" archetype); 100 units for
 * USAGE (mirrors the MaintenanceEditor's own default).
 */
const MAINTENANCE_INTERVAL_SEED: Record<MaintenanceBasis, number> = { TIME: 365, USAGE: 100 };

/**
 * "Defaults for new items in this category" — the editor for the category-template defaults:
 * the T1/T2 soft-prefills (tracking mode, condition, warranty window) plus the T2a default
 * *maintenance schedule*. These are plain LWW columns with no draft/confirm model, so each
 * control **auto-saves immediately** via `useUpdateCategory` (mirroring the Settings dialog's
 * per-row auto-save), clearing to `null`. This is a direct read-from-category / write-back
 * editor — the T1/T2 *soft-prefill* logic lives on the create form, and the T2a schedule is
 * *applied* by the item create paths, not here.
 */
function CategoryDefaultsSection({ category }: { category: CategoryWithFieldCount }) {
  const updateCategory = useUpdateCategory();
  const save = (input: {
    defaultTrackingMode?: TrackingMode | null;
    defaultCondition?: Condition | null;
    defaultWarrantyMonths?: number | null;
    defaultMaintenanceBasis?: MaintenanceBasis | null;
    defaultMaintenanceIntervalDays?: number | null;
    defaultMaintenanceIntervalUsage?: number | null;
  }) => updateCategory.mutate({ id: category.id, input });

  // The warranty field is a free-text number, so it keeps a local buffer (reset when the
  // selected category changes) rather than being driven straight from the persisted value —
  // that keeps mid-edit keystrokes from being clobbered by the write-back refresh.
  const [warrantyText, setWarrantyText] = useState(
    category.defaultWarrantyMonths != null ? String(category.defaultWarrantyMonths) : '',
  );
  useEffect(() => {
    setWarrantyText(category.defaultWarrantyMonths != null ? String(category.defaultWarrantyMonths) : '');
  }, [category.id, category.defaultWarrantyMonths]);

  const commitWarranty = (raw: string) => {
    setWarrantyText(raw);
    const trimmed = raw.trim();
    if (trimmed === '') {
      save({ defaultWarrantyMonths: null });
      return;
    }
    const months = Number.parseInt(trimmed, 10);
    // Only persist a valid whole-month window (>= 1); an in-progress/invalid entry is held
    // in the buffer until it parses, never written as junk.
    if (Number.isInteger(months) && months >= 1) {
      save({ defaultWarrantyMonths: months });
    }
  };

  // Default maintenance schedule (backlog T2a). Like the warranty field, the interval keeps a
  // local buffer so mid-edit keystrokes aren't clobbered by the write-back refresh; it is seeded
  // from whichever interval column matches the persisted basis.
  const maintBasis = category.defaultMaintenanceBasis;
  const persistedInterval =
    maintBasis === 'TIME'
      ? category.defaultMaintenanceIntervalDays
      : maintBasis === 'USAGE'
        ? category.defaultMaintenanceIntervalUsage
        : null;
  const [maintIntervalText, setMaintIntervalText] = useState(
    persistedInterval != null ? String(persistedInterval) : '',
  );
  useEffect(() => {
    setMaintIntervalText(persistedInterval != null ? String(persistedInterval) : '');
  }, [category.id, persistedInterval]);

  // Persist the {basis, matching-interval} pair coherently: only the interval column for the
  // chosen basis is set, the other is nulled. A blank/invalid interval stores null — a
  // half-configured default the item create paths treat as a no-op — so nothing junk is written.
  const saveMaintenance = (basis: MaintenanceBasis, text: string) => {
    const n = Number.parseInt(text.trim(), 10);
    const val = text.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
    save({
      defaultMaintenanceBasis: basis,
      defaultMaintenanceIntervalDays: basis === 'TIME' ? val : null,
      defaultMaintenanceIntervalUsage: basis === 'USAGE' ? val : null,
    });
  };

  const changeBasis = (value: string) => {
    if (value === '') {
      setMaintIntervalText('');
      save({
        defaultMaintenanceBasis: null,
        defaultMaintenanceIntervalDays: null,
        defaultMaintenanceIntervalUsage: null,
      });
      return;
    }
    const basis = value as MaintenanceBasis;
    // Seed a friendly interval when the field is empty, so a just-chosen basis is effective
    // straight away (never a silent no-op); keep any number the user already typed.
    const seeded = maintIntervalText.trim() || String(MAINTENANCE_INTERVAL_SEED[basis]);
    setMaintIntervalText(seeded);
    saveMaintenance(basis, seeded);
  };

  const commitInterval = (raw: string) => {
    setMaintIntervalText(raw);
    if (maintBasis == null) return; // no basis chosen yet — nothing to attach the interval to
    saveMaintenance(maintBasis, raw);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/10 p-2.5">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        Defaults for new items in this category
        <InfoHint content="Pre-fill the create-item form for this category. Each is a **starting point** you can still change per item — changing them here never touches existing items." />
      </h4>

      <SelectField
        label="Tracking mode"
        hint="How a new item in this category is tracked by default — e.g. **Serialised** for tools you track one-by-one. Choose *— No default —* to leave it unset."
        value={category.defaultTrackingMode ?? ''}
        onChange={(value) => save({ defaultTrackingMode: value === '' ? null : (value as TrackingMode) })}
        options={[
          { value: '', label: '— No default —' },
          ...TRACKING_MODES.map((mode) => ({ value: mode, label: TRACKING_MODE_LABELS[mode] })),
        ]}
      />

      <SelectField
        label="Condition"
        hint="The condition a new item in this category starts in — e.g. **Good**. Choose *— No default —* to leave it unset."
        value={category.defaultCondition ?? ''}
        onChange={(value) => save({ defaultCondition: value === '' ? null : (value as Condition) })}
        options={conditionSelectOptions('— No default —')}
      />

      <FormField
        label="Warranty (months)"
        hint={
          'A default warranty **window in whole months** (not a date). On create it is turned ' +
          'into an expiry date measured from the item’s *Acquired date* (or today) — so *12* ' +
          'here means a new item is under warranty for a year. Leave blank for no default.'
        }
      >
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="e.g. 12"
          aria-label="Default warranty in months"
          value={warrantyText}
          onChange={(e) => commitWarranty(e.target.value)}
        />
      </FormField>

      <SelectField
        label="Maintenance schedule"
        hint={
          'Give new items in this category a **recurring service schedule** automatically — e.g. an ' +
          'annual calibration. Unlike the fields above (which only pre-fill the create form), this ' +
          'schedule is **created on the item** the moment it is added.\n\n' +
          '- **Time-based** — due every N **days**.\n' +
          '- **Usage-based** — due every N units of use.\n\n' +
          'Choose *— No default —* for none. You can rename or tweak each schedule on the item later.'
        }
        value={maintBasis ?? ''}
        onChange={changeBasis}
        options={[
          { value: '', label: '— No default —' },
          ...MAINTENANCE_BASES.map((b) => ({ value: b, label: MAINTENANCE_BASIS_LABELS[b] })),
        ]}
      />

      {maintBasis != null ? (
        <FormField
          label={maintBasis === 'TIME' ? 'Every (days)' : 'Every (uses)'}
          hint={
            maintBasis === 'TIME'
              ? 'How often the service falls due, in **whole days** — e.g. *365* for a yearly ' +
                'calibration. Clear it to leave the schedule off.'
              : 'How many **units of use** between services — e.g. *100* running hours. Clear it to ' +
                'leave the schedule off.'
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={maintBasis === 'TIME' ? 'e.g. 365' : 'e.g. 100'}
            aria-label={
              maintBasis === 'TIME'
                ? 'Default maintenance interval in days'
                : 'Default maintenance usage interval'
            }
            value={maintIntervalText}
            onChange={(e) => commitInterval(e.target.value)}
          />
        </FormField>
      ) : null}
    </div>
  );
}

/** Comma-separated Choices text → the trimmed, non-blank option list. */
function parseChoices(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * The **due-date opt-in** for an existing `DATE` custom field (W1a) — a tick plus a notice
 * period, saved straight onto the shared dictionary definition.
 *
 * Two things it deliberately does *not* do. It does not offer the opt-in on any other field
 * type, because only a date can be a deadline (the schema's CHECK says the same). And it does
 * not present the tick and the number as two independent settings: the stored value *is* the
 * opt-in — `null` means "just a date" — so ticking seeds {@link FIELD_DUE_LEAD_DAYS_DEFAULT}
 * and unticking clears it, and there is no state where the field is a deadline with no notice.
 *
 * The number saves on **blur**, not per keystroke: the control is fed from server state, so
 * writing on every change races the refetch and drops digits (the same rule the location-field
 * editor follows). The tick saves immediately, since it is a single discrete decision.
 */
function FieldDueDateControl({ field }: { field: CategoryField }) {
  const t = useT();
  const updateField = useUpdateCategoryField();
  const describeError = useErrorMessage();
  const [error, setError] = useState<string | null>(null);
  // Seeded from the definition and re-seeded whenever it changes underneath us (another
  // category sharing this field, or a peer's sync) — `key` on the id would not do it, since
  // the row survives the change.
  // The box is fed from server state and re-seats whenever the stored value moves — this save's
  // own refetch, another category editing the shared definition, a peer's sync. A concurrent
  // change can therefore land over something half-typed; that is what "fed from server state"
  // means, it is self-correcting (the new value is on screen to retype from), and guarding it
  // would trade a rare, visible overwrite for a focus-tracking state machine that can push a
  // *stale* value back on blur instead — quietly, and over the newer one.
  const [draft, setDraft] = useState(String(field.dueLeadDays ?? FIELD_DUE_LEAD_DAYS_DEFAULT));
  useEffect(() => {
    setDraft(String(field.dueLeadDays ?? FIELD_DUE_LEAD_DAYS_DEFAULT));
  }, [field.dueLeadDays]);

  const save = (dueLeadDays: number | null) => {
    setError(null);
    updateField.mutate(
      { fieldId: field.id, input: { dueLeadDays } },
      { onError: (e) => setError(describeError(e, t('inventory.fields.dueDate.saveFailed'))) },
    );
  };

  /**
   * Commit the typed notice period, or put the stored one back.
   *
   * A blank box is **not** zero. `Number('')` is `0` and the clamp floors at 0, so coercing
   * would silently reconfigure a field from "30 days" to "on the day" the moment someone
   * selected the value, hit delete and tabbed away — a legal value, so nothing would complain.
   * A `type="number"` input also reports `''` for un-parseable keystrokes, which takes the same
   * path. Blank therefore reverts.
   */
  const commitDraft = () => {
    const typed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(typed)) {
      setDraft(String(field.dueLeadDays ?? FIELD_DUE_LEAD_DAYS_DEFAULT));
      return;
    }
    const next = clampFieldDueLeadDays(typed);
    setDraft(String(next));
    if (next !== field.dueLeadDays) save(next);
  };

  const enabled = field.dueLeadDays != null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <Checkbox
          checked={enabled}
          onChange={(e) => save(e.target.checked ? FIELD_DUE_LEAD_DAYS_DEFAULT : null)}
          aria-label={t('inventory.fields.dueDate.toggleLabel', { vars: { name: field.name } })}
          data-testid={`field-due-toggle-${field.id}`}
        />
        {t('inventory.fields.dueDate.label')}
      </label>
      <InfoHint content={t('inventory.fields.dueDate.hint')} />
      {enabled ? (
        <>
          {/* `calc={false}`: a notice period is a plain count of days, never a sum worth typing —
              and it keeps this a real `type="number"` box, so `min`/`max` are native constraints
              rather than inert attributes on the calculator control's text field. */}
          <Input
            type="number"
            calc={false}
            min={FIELD_DUE_LEAD_DAYS_MIN}
            max={FIELD_DUE_LEAD_DAYS_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            aria-label={t('inventory.fields.dueDate.noticeLabel', { vars: { name: field.name } })}
            data-testid={`field-due-days-${field.id}`}
            className="h-8 w-20"
          />
          {t('inventory.fields.dueDate.noticeSuffix')}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The notice period a typed value means: the clamped number, or {@link FIELD_DUE_LEAD_DAYS_DEFAULT}
 * when the box is blank or holds something that is not a number.
 *
 * Blank deliberately does **not** mean zero. `Number('')` is `0`, and 0 is a legal notice period
 * ("tell me on the day"), so coercing would turn "I cleared the box to retype it" into a silent,
 * valid, wrong setting that nothing would flag.
 */
function resolveLeadDays(raw: string): number {
  const typed = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(typed)) return FIELD_DUE_LEAD_DAYS_DEFAULT;
  return clampFieldDueLeadDays(typed);
}

/**
 * What a typed bound means (W1c): the number, `null` when the box is **empty**, or `undefined`
 * for anything that is not a number — meaning "leave the stored bound alone".
 *
 * The three-way answer is the point. Unlike the due-date notice period, where blank had to
 * revert because the field was already opted in and every number was a legal setting, a blank
 * bound has its own meaning here: *unbounded on that side*. So blank clears, and only genuinely
 * un-parseable text (a lone `-` mid-type, a stray letter) reverts — otherwise half-typing a
 * negative bound would clear the one already set.
 */
function resolveBound(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  const typed = Number(raw);
  return Number.isFinite(typed) ? typed : undefined;
}

/**
 * What a typed precision means (W1e): a whole number of decimal places, `null` when the box is
 * **empty** — "as entered", the default — or `undefined` for anything that is not a number, which
 * means "leave the stored setting alone".
 *
 * Blank clears for the same reason a bound's does, and for the opposite reason to the due-date
 * notice period: an empty box already states a legitimate setting here, so coercing it to a number
 * would remove the only way to say "as entered".
 *
 * Unlike a bound, this one is *clamped* rather than passed on to be refused. A count of decimal
 * places is a bounded whole number, exactly as a notice period is, so `2.5` settling to `3` and
 * `9` settling to the cap is a predictable read of what was typed rather than a rejection the user
 * has to act on. The control's `maxLength` of 1 narrows what can reach the clamp by typing to a
 * single digit above the cap — `7`, `8` or `9`; anything further out has to be pasted.
 */
function resolvePrecision(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  const typed = Number(raw);
  if (!Number.isFinite(typed)) return undefined;
  return Math.min(FIELD_PRECISION_MAX, Math.max(FIELD_PRECISION_MIN, Math.round(typed)));
}

/**
 * The **key-field** mark on an existing custom field (W1d), saved onto the shared dictionary
 * definition.
 *
 * Offered on every field type, unlike its two neighbours below: a unit belongs to a number and a
 * notice period to a date, but any field can be the one that matters most.
 *
 * A bare tick with no value beside it — there is nothing here for a stored value to *be*, so the
 * tick is the whole setting and cannot disagree with anything it gates (the rule W1a's single
 * `due_lead_days` column was really about). It saves immediately rather than on blur for the same
 * reason: a checkbox has no half-typed state to race the refetch with.
 */
function FieldKeyControl({ field }: { field: CategoryField }) {
  const t = useT();
  const updateField = useUpdateCategoryField();
  const describeError = useErrorMessage();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <label className="flex items-center gap-1.5">
        <Checkbox
          checked={isKeyField(field.prominence)}
          onChange={(e) => {
            setError(null);
            updateField.mutate(
              {
                fieldId: field.id,
                // 'default' rather than null so the intent is stated in the vocabulary's own
                // terms; the write seam folds it to NULL either way.
                input: { prominence: e.target.checked ? KEY_FIELD_PROMINENCE : 'default' },
              },
              { onError: (err) => setError(describeError(err, t('inventory.fields.key.saveFailed'))) },
            );
          }}
          aria-label={t('inventory.fields.key.toggleLabel', { vars: { name: field.name } })}
          data-testid={`field-key-toggle-${field.id}`}
        />
        {t('inventory.fields.key.label')}
      </label>
      <InfoHint content={t('inventory.fields.key.hint')} />
      {error ? (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The **unit, range and decimal places** of an existing `NUMBER` custom field (W1b/W1c/W1e),
 * saved onto the shared dictionary definition.
 *
 * One control for all four boxes rather than four independent ones: they share a row, a save
 * failure, and a definition, and separate controls would each fire their own mutation against
 * the same non-optimistic refetch. It offers nothing on any other field type, because only a
 * number has a unit, a range or a number of decimal places (the schema's CHECKs say the same).
 *
 * There is no tick here, unlike the due-date opt-in. Each setting's *stored value is* the
 * opt-in — an empty unit is "unitless", an empty bound is "unbounded that side", and an empty
 * decimals box is "as entered" — so a tick would only add a second way to say what an empty box
 * already says. Everything commits on **blur** for the reason W1a documents: the boxes are fed
 * from server state, so writing per keystroke races the refetch.
 */
function FieldNumberOptionsControl({ field }: { field: CategoryField }) {
  const t = useT();
  const updateField = useUpdateCategoryField();
  const describeError = useErrorMessage();
  const [error, setError] = useState<string | null>(null);

  // Fed from server state and re-seated whenever the definition changes underneath us — see
  // the note in {@link FieldDueDateControl} for why a concurrent overwrite is accepted here.
  const [unit, setUnit] = useState(field.unit ?? '');
  const [min, setMin] = useState(field.minValue == null ? '' : String(field.minValue));
  const [max, setMax] = useState(field.maxValue == null ? '' : String(field.maxValue));
  // `== null` throughout, never falsiness: `precision` of 0 is the "whole numbers only" setting,
  // and a truthy test would show its box empty — i.e. as "as entered", the opposite of what it says.
  const [precision, setPrecision] = useState(field.precision == null ? '' : String(field.precision));
  useEffect(() => setUnit(field.unit ?? ''), [field.unit]);
  useEffect(() => setMin(field.minValue == null ? '' : String(field.minValue)), [field.minValue]);
  useEffect(() => setMax(field.maxValue == null ? '' : String(field.maxValue)), [field.maxValue]);
  useEffect(() => setPrecision(field.precision == null ? '' : String(field.precision)), [field.precision]);

  const save = (input: UpdateCategoryFieldInput) => {
    setError(null);
    updateField.mutate(
      { fieldId: field.id, input },
      { onError: (e) => setError(describeError(e, t('inventory.fields.number.saveFailed'))) },
    );
  };

  const commitUnit = () => {
    const next = unit.trim() === '' ? null : unit.trim();
    setUnit(next ?? '');
    if (next !== field.unit) save({ unit: next });
  };

  /**
   * Commit one end of the range: write the parsed bound, or put the stored one back when the
   * box holds something that is not a number. `end` names which column the write targets, so
   * one edit can never send both ends and the untouched one keeps whatever it already had.
   */
  const commitBound = (
    raw: string,
    stored: number | null,
    setDraft: (v: string) => void,
    end: 'minValue' | 'maxValue',
  ) => {
    const next = resolveBound(raw);
    if (next === undefined) {
      setDraft(stored == null ? '' : String(stored));
      return;
    }
    setDraft(next == null ? '' : String(next));
    if (next !== stored) save({ [end]: next });
  };

  /**
   * Commit the decimal places: write the resolved count, or put the stored one back when the box
   * holds something that is not a number. The box is re-seated from the *resolved* value, so a
   * clamped entry shows what was actually stored rather than what was typed.
   */
  const commitPrecision = () => {
    const next = resolvePrecision(precision);
    if (next === undefined) {
      setPrecision(field.precision == null ? '' : String(field.precision));
      return;
    }
    setPrecision(next == null ? '' : String(next));
    if (next !== field.precision) save({ precision: next });
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {t('inventory.fields.number.unitLabel')}
      <Input
        value={unit}
        maxLength={FIELD_UNIT_MAX_LENGTH}
        onChange={(e) => setUnit(e.target.value)}
        onBlur={commitUnit}
        placeholder={t('inventory.fields.number.unitPlaceholder')}
        aria-label={t('inventory.fields.number.unitAria', { vars: { name: field.name } })}
        data-testid={`field-unit-${field.id}`}
        className="h-8 w-24"
      />
      {t('inventory.fields.number.rangeLabel')}
      {/* Deliberately a text box with a decimal keypad rather than `type="number"`. A native
          number input reports `''` for anything it cannot parse — including a lone `-` part-way
          through typing a negative bound — which is exactly the string that means "cleared"
          here, so it would silently drop a stored bound the moment someone retyped one. Keeping
          the raw text is what lets {@link resolveBound} tell "emptied" from "mid-edit". */}
      <Input
        inputMode="decimal"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        onBlur={() => commitBound(min, field.minValue, setMin, 'minValue')}
        aria-label={t('inventory.fields.number.minAria', { vars: { name: field.name } })}
        data-testid={`field-min-${field.id}`}
        className="h-8 w-24"
      />
      <span aria-hidden>–</span>
      <Input
        inputMode="decimal"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        onBlur={() => commitBound(max, field.maxValue, setMax, 'maxValue')}
        aria-label={t('inventory.fields.number.maxAria', { vars: { name: field.name } })}
        data-testid={`field-max-${field.id}`}
        className="h-8 w-24"
      />
      {t('inventory.fields.number.precisionLabel')}
      {/* A text box with a numeric keypad, for the same reason as the bounds above and one more:
          the count is a whole number, so `inputMode="numeric"` matches the due-date notice period
          rather than the decimal bounds. `maxLength` is 1 because the cap is a single digit, so a
          typed value can only ever overshoot it by one digit — see {@link resolvePrecision}. */}
      <Input
        inputMode="numeric"
        maxLength={1}
        value={precision}
        onChange={(e) => setPrecision(e.target.value)}
        onBlur={commitPrecision}
        aria-label={t('inventory.fields.number.precisionAria', { vars: { name: field.name } })}
        data-testid={`field-precision-${field.id}`}
        className="h-8 w-16"
      />
      <InfoHint content={t('inventory.fields.number.hint')} />
      {error ? (
        <p role="alert" className="w-full text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AddFieldForm({ categoryId }: { categoryId: string }) {
  const t = useT();
  const addField = useAddCategoryField();
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>('TEXT');
  const [options, setOptions] = useState('');
  const [isRequired, setIsRequired] = useState(false);
  // The key-field mark (W1d). Not gated on the field type, so it needs no clearing when the type
  // changes, unlike the two settings below.
  const [isKey, setIsKey] = useState(false);
  // The due-date opt-in (W1a). Kept as a tick plus a draft string rather than one nullable
  // number so clearing the box does not lose the notice period the user just typed; only the
  // tick decides whether anything is stored.
  const [isDueDate, setIsDueDate] = useState(false);
  const [dueLeadDays, setDueLeadDays] = useState(String(FIELD_DUE_LEAD_DAYS_DEFAULT));
  // The unit, range and decimal places of a NUMBER field (W1b/W1c/W1e). No tick to gate them,
  // unlike the due-date opt-in: an empty box already says "unitless" / "unbounded that side" /
  // "as entered", so a tick would only add a second way to say the same thing.
  const [unit, setUnit] = useState('');
  const [minValue, setMinValue] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const [precision, setPrecision] = useState('');
  const [defaultValue, setDefaultValue] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  // Advisory, never blocking: a custom "Manufacturer" is legitimate when the built-in column
  // goes unused, so the name is allowed — the duplicate is just made a choice rather than a
  // surprise the user only meets later, on an item showing the field twice.
  const builtInClash = builtInFieldNameClash(name);

  const submit = () => {
    setError(null);
    addField.mutate(
      {
        categoryId,
        input: {
          name,
          fieldType,
          isRequired,
          defaultValue: defaultValue.trim() || null,
          description: description.trim() || null,
          options: fieldType === 'SELECT' ? parseChoices(options) : null,
          // Only a DATE can carry it, and the tick is the opt-in — see `FieldDueDateControl`.
          // A blank or un-parseable box falls back to the default rather than to `Number('')`,
          // which is 0 and would silently create the field as "notify on the day".
          dueLeadDays: fieldType === 'DATE' && isDueDate ? resolveLeadDays(dueLeadDays) : null,
          // Only a NUMBER carries these. An empty or un-parseable box is `null` — "no unit",
          // "unbounded" and "as entered" respectively — so, unlike the notice period, there is no
          // default to fall back to and nothing is invented for a box the user left alone.
          unit: fieldType === 'NUMBER' ? unit.trim() || null : null,
          minValue: fieldType === 'NUMBER' ? (resolveBound(minValue) ?? null) : null,
          maxValue: fieldType === 'NUMBER' ? (resolveBound(maxValue) ?? null) : null,
          // `?? null` folds "leave the stored setting alone" into "not set", which is the right
          // read on a *create*: there is nothing to leave alone. It cannot swallow a `0` — that
          // is a number, not nullish — so "whole numbers only" survives the collapse.
          precision: fieldType === 'NUMBER' ? (resolvePrecision(precision) ?? null) : null,
          // Every type can carry this, so there is no type test. `null` rather than 'default'
          // when unticked, because on a name that resolves to an *existing* definition an
          // omission leaves it alone: adding a shared field here must not demote it elsewhere.
          prominence: isKey ? KEY_FIELD_PROMINENCE : null,
        },
      },
      {
        onError: (e) => setError(describeError(e, 'Could not add the field.')),
        onSuccess: () => {
          setName('');
          setOptions('');
          setDefaultValue('');
          setDescription('');
          setIsRequired(false);
          setIsKey(false);
          setIsDueDate(false);
          setDueLeadDays(String(FIELD_DUE_LEAD_DAYS_DEFAULT));
          setUnit('');
          setMinValue('');
          setMaxValue('');
          setPrecision('');
        },
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/10 p-2.5">
      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Field name"
          hint="The label for this field, shown on every item in this category — and as the column header if you export to CSV. Keep it short and specific, e.g. **Voltage**, **Warranty expiry**, **Colour**."
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Voltage"
            aria-label="Field name"
          />
        </FormField>
        <SelectField
          label="Field type"
          hint={`What kind of value this field holds — it controls the control shown on the item and the validation applied when saving:

- **Text** – a single line of free text.
- **Long text** – multi-line notes.
- **URL / Link** – a validated web address (e.g. a datasheet page).
- **Number** – any numeric value, decimals allowed.
- **Rating (1–5)** – a whole number from 1 to 5.
- **Yes / No** – a two-button toggle.
- **On / Off** – a checkbox — identical to Yes/No, just worded (and shown) differently.
- **Date** – a calendar date.
- **Choice** – one of a fixed list you define below.`}
          hintSize="md"
          value={fieldType}
          onChange={(value) => {
            // A default typed for the old field type rarely still makes sense for the
            // new one (e.g. free text becoming a date) — start it fresh.
            setFieldType(value as FieldType);
            setDefaultValue('');
            // The opt-in only exists on a date, so switching away from one retracts it rather
            // than leaving a tick set that the submit would silently discard.
            if (value !== 'DATE') setIsDueDate(false);
            // Likewise the unit, range and decimal places only exist on a number — clear them
            // rather than leave typed values behind that the submit would drop without saying so.
            if (value !== 'NUMBER') {
              setUnit('');
              setMinValue('');
              setMaxValue('');
              setPrecision('');
            }
          }}
          options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))}
        />
      </div>
      {fieldType === 'SELECT' ? (
        <FormField
          label="Choices"
          hint="The options this field can be set to, separated by commas — e.g. `Red, Green, Blue`. Shown as a dropdown on each item."
        >
          <Input
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            placeholder="Red, Green, Blue"
            aria-label="Choices"
          />
        </FormField>
      ) : null}
      <FormField
        label="Default value"
        hint="Shown for an item in this category that hasn't set this field yet (lenient defaulting) — it's never written to existing items, only displayed until they get their own value. Matches the control shown on the item itself."
      >
        <TypedFieldControl
          fieldType={fieldType}
          value={defaultValue}
          onChange={setDefaultValue}
          options={fieldType === 'SELECT' ? parseChoices(options) : null}
          ariaLabel="Default value"
        />
      </FormField>
      <FormField
        label="Description"
        // The hint points a unit at the Unit setting rather than at this note: two places to
        // state a unit would leave no answer for which one a reader should trust.
        hint={t('inventory.fields.descriptionHint')}
      >
        <Textarea
          sizeKey="category-field.description"
          autoGrow
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('inventory.fields.descriptionPlaceholder')}
          aria-label="Description"
          rows={2}
        />
      </FormField>
      <div className="flex items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
          Required
        </label>
        <InfoHint content="When on, an item in this category must have a value for this field before its custom fields can be saved." />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={isKey}
            onChange={(e) => setIsKey(e.target.checked)}
            data-testid="add-field-key"
          />
          {t('inventory.fields.key.label')}
        </label>
        <InfoHint content={t('inventory.fields.key.hint')} />
      </div>
      {fieldType === 'DATE' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={isDueDate}
              onChange={(e) => setIsDueDate(e.target.checked)}
              data-testid="add-field-due-toggle"
            />
            {t('inventory.fields.dueDate.label')}
          </label>
          <InfoHint content={t('inventory.fields.dueDate.hint')} />
          {isDueDate ? (
            <>
              <Input
                type="number"
                calc={false}
                min={FIELD_DUE_LEAD_DAYS_MIN}
                max={FIELD_DUE_LEAD_DAYS_MAX}
                value={dueLeadDays}
                onChange={(e) => setDueLeadDays(e.target.value)}
                onBlur={() => setDueLeadDays(String(resolveLeadDays(dueLeadDays)))}
                aria-label={t('inventory.fields.dueDate.addNoticeLabel')}
                data-testid="add-field-due-days"
                className="h-8 w-20"
              />
              <span className="text-xs text-muted-foreground">
                {t('inventory.fields.dueDate.noticeSuffix')}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {fieldType === 'NUMBER' ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {t('inventory.fields.number.unitLabel')}
          <Input
            value={unit}
            maxLength={FIELD_UNIT_MAX_LENGTH}
            onChange={(e) => setUnit(e.target.value)}
            placeholder={t('inventory.fields.number.unitPlaceholder')}
            aria-label={t('inventory.fields.number.addUnitLabel')}
            data-testid="add-field-unit"
            className="h-8 w-24"
          />
          {t('inventory.fields.number.rangeLabel')}
          {/* Text boxes with a decimal keypad, matching the existing-field control — see the
              note there for why a native number input cannot carry these. */}
          <Input
            inputMode="decimal"
            value={minValue}
            onChange={(e) => setMinValue(e.target.value)}
            aria-label={t('inventory.fields.number.addMinLabel')}
            data-testid="add-field-min"
            className="h-8 w-24"
          />
          <span aria-hidden>–</span>
          <Input
            inputMode="decimal"
            value={maxValue}
            onChange={(e) => setMaxValue(e.target.value)}
            aria-label={t('inventory.fields.number.addMaxLabel')}
            data-testid="add-field-max"
            className="h-8 w-24"
          />
          {t('inventory.fields.number.precisionLabel')}
          {/* Numeric rather than decimal, matching the existing-field control: the count of
              decimal places is itself a whole number. */}
          <Input
            inputMode="numeric"
            maxLength={1}
            value={precision}
            onChange={(e) => setPrecision(e.target.value)}
            aria-label={t('inventory.fields.number.addPrecisionLabel')}
            data-testid="add-field-precision"
            className="h-8 w-16"
          />
          <InfoHint content={t('inventory.fields.number.hint')} />
        </div>
      ) : null}
      {builtInClash ? (
        <Banner
          tone="warning"
          icon={<WarningIcon aria-hidden />}
          role="status"
          data-testid="field-builtin-clash"
          className="text-xs"
        >
          {t('inventory.fields.builtInClash', { vars: { name: builtInClash } })}
        </Banner>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!name.trim() || addField.isPending}>
          <AddIcon />
          Add field
        </Button>
      </div>
    </div>
  );
}

function DatasheetLinkingConfig() {
  const mode = usePreferencesStore((s) => s.attachmentMode);
  const setMode = usePreferencesStore((s) => s.setAttachmentMode);

  return (
    <div className="mt-5 rounded-xl border border-border bg-secondary/10 p-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        Datasheet linking
        <Tooltip
          content="**Option A** links external URLs only. **Option B** also lets you point at local PDFs — only the file *path* is stored and synced, never the file itself (§4)."
          openDelayMs={INFO_OPEN_DELAY_MS}
        >
          <span className="text-muted-foreground [&_svg]:size-3.5">
            <InfoIcon />
          </span>
        </Tooltip>
      </h3>
      <div className="space-y-1.5">
        {(Object.keys(ATTACHMENT_MODE_LABELS) as AttachmentMode[]).map((m) => (
          <label key={m} className="flex cursor-pointer items-center gap-2 text-sm">
            <Radio
              name="attachment-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
              className="size-3.5"
            />
            {ATTACHMENT_MODE_LABELS[m]}
          </label>
        ))}
      </div>
    </div>
  );
}
