import { useEffect, useRef, useState } from 'react';
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
} from '@/components/foundry';
import { AddIcon, CategoryIcon, CloseIcon, DeleteIcon, InfoIcon, WarningIcon } from '@/components/icons';
import {
  FIELD_TYPES,
  MAINTENANCE_BASES,
  TRACKING_MODES,
  type CategoryWithFieldCount,
  type Condition,
  type FieldType,
  type MaintenanceBasis,
  type TrackingMode,
} from '@/db/repositories';
import { useT } from '@/features/i18n';
import type { FeatureId } from '@/features/modules/feature-registry';
import { usePreferencesStore, type AttachmentMode } from '@/state/stores/usePreferencesStore';
import { builtInFieldNameClash } from '../builtin-field-names';
import { HIDEABLE_CAPABILITIES, toggleHiddenCapability } from '../category-capabilities';
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
          '**Settings → Item cards**.'
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
              className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-2.5 py-1.5 text-sm"
            >
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
            </li>
          ))
        )}
      </ul>

      <AddFieldForm categoryId={category.id} />

      <CategoryDefaultsSection category={category} />

      <CategoryHiddenSectionsPanel category={category} />
    </div>
  );
}

/**
 * Which sections this category's items don't need (issue #618).
 *
 * Deliberately a separate box from "Defaults for new items": those pre-fill a *new* item and
 * never touch existing ones, whereas this changes what **every** item in the category shows,
 * now and in future. Presenting them together would imply the wrong scope.
 *
 * Ticking hides — the question is "what doesn't this kind of thing have?", which is the way
 * round a user thinks about a Movie having no service schedule. Saving is immediate, matching
 * every other control in this dialog; a set toggle is never transiently invalid, so unlike the
 * warranty and interval fields it needs no local buffer.
 */
function CategoryHiddenSectionsPanel({ category }: { category: CategoryWithFieldCount }) {
  const t = useT();
  const updateCategory = useUpdateCategory();

  // Unlike every other control in this dialog, this one writes a *set* held in a single column,
  // so each toggle is a read-modify-write of the whole value. Reading the base from the query
  // cache would lose ticks: the write is not optimistic, so a second toggle made before the
  // refetch lands would compute from the pre-first-toggle array and silently drop it — and
  // since the column is synced LWW, that discard would propagate to other devices. Ticking
  // several boxes in a row is exactly how this control gets used, so the local draft is the
  // base, reseeded when a different category is selected (the buffer idiom used above).
  const [draft, setDraft] = useState<readonly string[]>(category.hiddenCapabilities);
  const seededFor = useRef(category.id);
  useEffect(() => {
    if (seededFor.current !== category.id) {
      seededFor.current = category.id;
      setDraft(category.hiddenCapabilities);
    }
  }, [category.id, category.hiddenCapabilities]);

  const hidden = new Set(draft);

  const toggle = (id: FeatureId, hide: boolean) => {
    const next = toggleHiddenCapability(draft, id, hide);
    setDraft(next);
    updateCategory.mutate({ id: category.id, input: { hiddenCapabilities: next } });
  };

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

function AddFieldForm({ categoryId }: { categoryId: string }) {
  const t = useT();
  const addField = useAddCategoryField();
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>('TEXT');
  const [options, setOptions] = useState('');
  const [isRequired, setIsRequired] = useState(false);
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
        hint="An optional note about this field. When set, an **(i)** info badge appears beside the field on each item, showing this text — a handy place for guidance such as *where to read the value from* or *which units to use*. Supports Markdown."
      >
        <Textarea
          sizeKey="category-field.description"
          autoGrow
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Read from the label on the base — in volts."
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
      </div>
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
