import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Controller, useForm, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AutocompleteField,
  Button,
  FormField,
  InfoHint,
  Input,
  Modal,
  SelectField,
  Textarea,
  useToast,
} from '@/components/foundry';
import { useFormatters } from '@/lib/useFormatters';
import {
  IN_TRANSIT_LOCATION_ID,
  TRACKING_MODES,
  UNASSIGNED_LOCATION_ID,
  type Category,
  type CreateItemInput,
  type Location,
  type LocationWithCount,
} from '@/db/repositories';
import { LOW_STOCK_GAUGE_SUGGESTED, LOW_STOCK_QTY_SUGGESTED } from '@/db/repositories/constants';
import { DEFAULT_AMAZON_MARKETPLACE, asinToUrl, marketplaceFromHost, parseAsin } from '../asin';
import { conditionSelectOptions, fromDateInputValue } from './inventory-ui';
import {
  applyScrapeMerge,
  buildScrapeMergePlan,
  buildSupplierPartPlan,
  ProductLookupPanel,
  resolveSupplierPartWrite,
  ScrapeSupplierPanel,
  useScrapeNotifier,
  type ProductLookupResultPayload,
  type ScrapeResultPayload,
} from '@/features/scraping';
import { useCategories } from '../categories';
import { useFieldSuggestions } from '../queries';
import { useApplyScrape, useCreateItem, useCreateSerialisedItems, useCreateSupplierPart } from '../mutations';
import { useAddItemImage } from '../media';
import { buildItemLocationOptions } from '../parent-options';
import { isLocationFull } from '../location-fullness';
import { CreateCategoryDialog } from './CreateCategoryDialog';
import { CreateLocationDialog } from './CreateLocationDialog';
import { LocationSelect } from './LocationSelect';
import { TRACKING_MODE_LABELS } from './inventory-ui';

/**
 * Item creation form (spec §2.4.4) — React Hook Form bound to a Zod schema via
 * @hookform/resolvers/zod, so validation runs without re-rendering on every
 * keystroke. The gauge fields appear only for CONSUMABLE_GAUGE items (§4.1.1);
 * DISCRETE items additionally offer a per-item low-stock override (Phase 59
 * reorder policy). The Location and Category pickers each carry an inline
 * "＋ New …" row that stacks a creation dialog on top of this one, so a missing
 * destination can be created without losing anything already typed here.
 */
const schema = z
  .object({
    name: z.string().trim().min(1, 'Please enter a name.'),
    description: z.string().optional(),
    notes: z.string().optional(),
    locationId: z.string().min(1, 'Please choose a location.'),
    categoryId: z.string().optional(),
    trackingMode: z.enum(TRACKING_MODES),
    mpn: z.string().optional(),
    manufacturer: z.string().optional(),
    barcode: z.string().optional(),
    unitCost: z.string().optional(),
    expiryDate: z.string().optional(),
    batchNumber: z.string().optional(),
    lotNumber: z.string().optional(),
    condition: z.string().optional(),
    quantity: z.string().optional(),
    count: z.string().optional(),
    unitOfMeasure: z.string().optional(),
    grossCapacity: z.string().optional(),
    tareWeight: z.string().optional(),
    currentNetValue: z.string().optional(),
    // Low-stock alerts are opt-in: this toggle arms them for the item (Add-item dialog).
    // When off, the reorder fields below are hidden and never submitted (item stays off).
    lowStockAlert: z.boolean().optional(),
    reorderPoint: z.string().optional(),
    reorderQty: z.string().optional(),
    reorderGaugePercent: z.string().optional(),
    // "Unlimited supply" modifier (Phase 82) — DISCRETE-only; the UI only surfaces it there.
    isUnlimited: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.trackingMode === 'CONSUMABLE_GAUGE') {
      if (!v.unitOfMeasure?.trim()) {
        ctx.addIssue({ path: ['unitOfMeasure'], code: 'custom', message: 'Required for consumables.' });
      }
      if (!(v.grossCapacity && Number(v.grossCapacity) > 0)) {
        ctx.addIssue({ path: ['grossCapacity'], code: 'custom', message: 'Enter a positive capacity.' });
      }
    }
  });

type FormValues = z.infer<typeof schema>;

// Sentinel picker values for the inline "create it here" rows (never submitted).
const CREATE_LOCATION_VALUE = '__create-location__';
const CREATE_CATEGORY_VALUE = '__create-category__';

/**
 * Optional seed values for a pre-filled draft (Web Share Target / deep link — plan EI-4). Only the
 * text fields a share can populate are accepted; the form keeps its own defaults for the rest and
 * the user always confirms before anything is created. `sourceUrl` is not a form field — it
 * pre-seeds the supplier-scraper panel's URL box so the shared link can be enriched in one click.
 */
export interface CreateItemInitialValues {
  name?: string;
  notes?: string;
  mpn?: string;
  /** Pre-fills the Description field — e.g. a listing title from an active-tab scrape (Path A2). */
  description?: string;
  /** Pre-fills the Manufacturer field — e.g. the brand from an active-tab scrape. */
  manufacturer?: string;
  /** Pre-fills the Unit cost field (a decimal string) — e.g. an Amazon buy-box price. */
  unitCost?: string;
  /** Retail barcode (GTIN) — pre-filled when adding an item from a scanned barcode (point 1). */
  barcode?: string;
  sourceUrl?: string;
}

/** Shared copy for the "alert me when this runs low" opt-in (both tracking modes). */
const LOW_STOCK_ALERT_HINT =
  'Watch this item and flag it on the dashboard’s **Low Stock** list — and in reorder ' +
  'suggestions — when it runs low.\n\nLow-stock alerts are **opt-in**: off by default, so ' +
  'nothing nags unless you switch it on here. You set the trigger level next, and can change ' +
  'it (or turn it off) later from the item’s **Supplier & ops** tab.';

/**
 * The "alert me when this runs low" opt-in for the Add-item dialog — an explicit,
 * discoverable switch for the otherwise-implicit reorder point. It is **off by default**
 * (matching the opt-in low-stock model), and only when it is on are the threshold fields
 * (`children`) revealed and submitted. `onToggle` seeds a suggested trigger the moment it
 * is enabled, so the revealed field is never left blank.
 *
 * A plain checkbox (not a Foundry primitive — none exists yet) matching the sibling
 * "Unlimited supply" control's pattern in this dialog.
 */
function LowStockAlertToggle({
  register,
  enabled,
  onToggle,
  children,
}: {
  register: UseFormRegister<FormValues>;
  enabled: boolean;
  onToggle: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          data-testid="item-low-stock-alert"
          {...register('lowStockAlert', {
            onChange: (e) => onToggle((e.target as HTMLInputElement).checked),
          })}
        />
        Alert me when this runs low
        <InfoHint content={LOW_STOCK_ALERT_HINT} />
      </label>
      {enabled ? children : null}
    </div>
  );
}

export function CreateItemDialog({
  open,
  onClose,
  locations,
  defaultLocationId,
  initialValues,
  initialImage,
  initialScrape,
}: {
  open: boolean;
  onClose: () => void;
  locations: readonly LocationWithCount[];
  defaultLocationId?: string;
  initialValues?: CreateItemInitialValues;
  /** An image shared into Gubbins (plan EI-4), attached to the item once the user confirms. */
  initialImage?: Blob;
  /**
   * An active-tab scrape (Path A2) whose per-supplier pricing is persisted as an **Amazon
   * supplier part** once the item is created — the ASIN as its order code, the buy-box price
   * as its unit cost — through the §4 no-overwrite-safe {@link resolveSupplierPartWrite}. The
   * item's own fields are pre-filled separately via {@link initialValues}; this carries the
   * supplier-side data that has no form field. Omitted for every other add-item entry point.
   */
  initialScrape?: ScrapeResultPayload;
}) {
  const createItem = useCreateItem();
  const createSerialised = useCreateSerialisedItems();
  const applyScrape = useApplyScrape();
  const createSupplierPart = useCreateSupplierPart();
  const addImage = useAddItemImage();
  const notifyScrape = useScrapeNotifier();
  const { show } = useToast();
  const { data: categories } = useCategories();
  const { data: manufacturerSuggestions } = useFieldSuggestions('manufacturer');
  const { data: unitSuggestions } = useFieldSuggestions('unitOfMeasure');
  const fmt = useFormatters();
  const locationLabelId = useId();
  // Focus the Name field on open so the dialog is ready to type into (the Modal otherwise
  // parks focus on its container). RHF's own field ref is composed with this one below.
  const nameRef = useRef<HTMLInputElement>(null);
  // Supplier MPNs to map onto the new item as aliases once it is created (§4).
  const [pendingAliases, setPendingAliases] = useState<readonly string[]>([]);
  // Which inline "create it without leaving this form" dialog is stacked on top (§4):
  // choosing "＋ New location…"/"＋ New category…" in a picker opens it; the half-filled
  // item form underneath stays mounted, so nothing the user has typed is lost.
  const [inlineCreate, setInlineCreate] = useState<'location' | 'category' | null>(null);
  // "Add by ASIN / Amazon URL" (single-item, extension-free): the raw box value, its
  // validation error, and the synthesised Amazon supplier part a valid ASIN produces. The
  // part rides to the create the same way an A2 active-tab scrape does (`persistAmazonSupplier`
  // below), so nothing hits the network — the ASIN becomes an Amazon order code + canonical
  // listing URL through the §4 no-overwrite-safe write path. Typed input wins over any
  // `initialScrape`, since it is the more recent, explicit user intent.
  const [asinInput, setAsinInput] = useState('');
  const [asinError, setAsinError] = useState<string | undefined>(undefined);
  const [asinPart, setAsinPart] = useState<ScrapeResultPayload | null>(null);
  const {
    control,
    register,
    handleSubmit,
    watch,
    reset,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialValues?.name ?? '',
      description: initialValues?.description ?? '',
      notes: initialValues?.notes ?? '',
      locationId: defaultLocationId ?? UNASSIGNED_LOCATION_ID,
      categoryId: '',
      trackingMode: 'DISCRETE',
      mpn: initialValues?.mpn ?? '',
      manufacturer: initialValues?.manufacturer ?? '',
      barcode: initialValues?.barcode ?? '',
      unitCost: initialValues?.unitCost ?? '',
      expiryDate: '',
      batchNumber: '',
      lotNumber: '',
      condition: '',
      quantity: '1',
      count: '1',
      unitOfMeasure: 'g',
      grossCapacity: '1000',
      tareWeight: '0',
      currentNetValue: '',
      lowStockAlert: false,
      reorderPoint: '',
      reorderQty: '',
      reorderGaugePercent: '',
      isUnlimited: false,
    },
  });

  const trackingMode = watch('trackingMode');
  const lowStockAlert = watch('lowStockAlert') ?? false;
  const isUnlimited = watch('isUnlimited') ?? false;

  // Opting an item in seeds a friendly non-zero reorder point so the user isn't left
  // staring at a blank required-feeling field (they can still change or clear it). Only
  // seeds when currently empty, so re-ticking never clobbers a value they've typed.
  const seedLowStockDefaults = (checked: boolean) => {
    if (!checked) return;
    if (trackingMode === 'DISCRETE' && !getValues('reorderPoint')?.trim()) {
      setValue('reorderPoint', String(LOW_STOCK_QTY_SUGGESTED));
    }
    if (trackingMode === 'CONSUMABLE_GAUGE' && !getValues('reorderGaugePercent')?.trim()) {
      setValue('reorderGaugePercent', String(LOW_STOCK_GAUGE_SUGGESTED));
    }
  };
  const isPending = createItem.isPending || createSerialised.isPending;

  // Every location is a valid home — including the system Unassigned / In Transit rows —
  // each tinted with its colour swatch and showing its item count (mirrors MoveItemDialog).
  // A pinned "＋ New location…" row at the foot opens the inline-create dialog, so a
  // missing home can be created without abandoning the half-filled item form.
  const locationOptions = useMemo(
    () => [
      ...buildItemLocationOptions(locations, fmt.quantity),
      { value: CREATE_LOCATION_VALUE, label: '＋ New location…', kind: 'action' as const },
    ],
    [locations, fmt],
  );

  // Soft, non-blocking heads-up when the chosen home is already at/over its capacity: the
  // add is still allowed (capacity is a guideline, not a hard cap), but the user is warned.
  const chosenLocationId = watch('locationId');
  const fullLocation = useMemo(() => {
    const loc = locations.find((l) => l.id === chosenLocationId);
    return loc && isLocationFull(loc.itemCount, loc.capacity) ? loc : null;
  }, [locations, chosenLocationId]);

  // §4 no-overwrite: a scrape only fills fields the user has left blank on the form.
  const onScrapeResult = (payload: ScrapeResultPayload) => {
    const v = getValues();
    const plan = buildScrapeMergePlan(
      {
        mpn: v.mpn?.trim() || null,
        manufacturer: v.manufacturer?.trim() || null,
        description: v.description?.trim() || null,
        unitCost: v.unitCost?.trim() ? Number(v.unitCost) : null,
        aliases: [],
      },
      payload,
    );
    const write = applyScrapeMerge(plan); // FILL fields only — no opt-in overwrites here
    const filled: string[] = [];
    if (write.fields.description !== undefined) {
      setValue('description', write.fields.description ?? '', { shouldDirty: true });
      filled.push('description');
    }
    if (write.fields.mpn !== undefined) {
      setValue('mpn', write.fields.mpn, { shouldDirty: true });
      filled.push('MPN');
    }
    if (write.fields.manufacturer !== undefined) {
      setValue('manufacturer', write.fields.manufacturer, { shouldDirty: true });
      filled.push('manufacturer');
    }
    if (write.fields.unitCost !== undefined) {
      setValue('unitCost', String(write.fields.unitCost), { shouldDirty: true });
      filled.push('unit cost');
    }
    setPendingAliases(write.aliasAdditions);
    const host = (() => {
      try {
        return new URL(payload.distributor_url).hostname;
      } catch {
        return 'supplier';
      }
    })();
    notifyScrape(
      filled.length > 0
        ? `Filled ${filled.join(', ')} from ${host}.`
        : `No empty fields to fill from ${host}.`,
    );
  };

  // §4 no-overwrite: a keyless barcode lookup (recommendation point 2) only fills fields the
  // user has left blank, exactly like the supplier scrape above.
  const onProductLookup = (payload: ProductLookupResultPayload) => {
    const v = getValues();
    const filled: string[] = [];
    if (!v.name?.trim()) {
      setValue('name', payload.name, { shouldDirty: true });
      filled.push('name');
    }
    if (payload.brand && !v.manufacturer?.trim()) {
      setValue('manufacturer', payload.brand, { shouldDirty: true });
      filled.push('manufacturer');
    }
    if (payload.description && !v.description?.trim()) {
      setValue('description', payload.description, { shouldDirty: true });
      filled.push('description');
    }
    notifyScrape(
      filled.length > 0
        ? `Filled ${filled.join(', ')} from Open Food Facts.`
        : 'No empty fields to fill from Open Food Facts.',
    );
  };

  // "Add by ASIN / Amazon URL": parse the box (a bare ASIN or a `/dp/` listing link) via the
  // pure {@link parseAsin} seam. Invalid input surfaces an accessible error; a valid one
  // synthesises an Amazon supplier part — the ASIN as its order code, the canonical listing
  // URL as its link (marketplace derived from a pasted URL's host, else the locale default) —
  // recorded on create through the same §4 no-overwrite-safe path Path A2 uses. Fully offline:
  // no field is overwritten and the notes provenance is filled only when the user left it blank.
  const applyAsin = () => {
    const raw = asinInput.trim();
    const asin = parseAsin(raw);
    if (!asin) {
      setAsinPart(null);
      setAsinError('Enter a valid Amazon ASIN (like B0F3XF5ZKF) or a product link.');
      return;
    }
    let marketplace = DEFAULT_AMAZON_MARKETPLACE;
    try {
      marketplace = marketplaceFromHost(new URL(raw).hostname) ?? DEFAULT_AMAZON_MARKETPLACE;
    } catch {
      // A bare ASIN is not a URL — keep the locale default marketplace.
    }
    const url = asinToUrl(asin, marketplace);
    setAsinError(undefined);
    setAsinPart({
      mpn: asin,
      manufacturer: '',
      description: '',
      distributor_url: url,
      scraped_pricing: null,
    });
    if (!getValues('notes')?.trim()) {
      setValue('notes', `Amazon ASIN: ${asin}\nListing: ${url}`, { shouldDirty: true });
    }
  };

  const onSubmit = (values: FormValues) => {
    const base = {
      name: values.name.trim(),
      locationId: values.locationId,
      categoryId: values.categoryId ? values.categoryId : undefined,
      trackingMode: values.trackingMode,
      ...(values.description?.trim() ? { description: values.description.trim() } : {}),
      ...(values.notes?.trim() ? { notes: values.notes.trim() } : {}),
      ...(values.mpn?.trim() ? { mpn: values.mpn.trim() } : {}),
      ...(values.manufacturer?.trim() ? { manufacturer: values.manufacturer.trim() } : {}),
      ...(values.barcode?.trim() ? { barcode: values.barcode.trim() } : {}),
      ...(values.unitCost?.trim() ? { unitCost: Number(values.unitCost) } : {}),
      // Phase 9 perishables & condition (§4) — all optional.
      ...(values.expiryDate?.trim() ? { expiryDate: fromDateInputValue(values.expiryDate) } : {}),
      ...(values.batchNumber?.trim() ? { batchNumber: values.batchNumber.trim() } : {}),
      ...(values.lotNumber?.trim() ? { lotNumber: values.lotNumber.trim() } : {}),
      ...(values.condition ? { condition: values.condition as CreateItemInput['condition'] } : {}),
      // Per-item low-stock overrides (Phase 59 reorder policy). Low-stock alerts are
      // opt-in — only sent when the "alert me when this runs low" toggle is on, so leaving
      // it off keeps the item unwatched even if a stale value lingers in a hidden field.
      ...(values.lowStockAlert && values.reorderPoint?.trim()
        ? { reorderPoint: Number(values.reorderPoint) }
        : {}),
      ...(values.lowStockAlert && values.reorderQty?.trim() ? { reorderQty: Number(values.reorderQty) } : {}),
      ...(values.lowStockAlert && values.reorderGaugePercent?.trim()
        ? { reorderGaugePercent: Number(values.reorderGaugePercent) }
        : {}),
    };
    const done = () => {
      reset();
      setPendingAliases([]);
      setInlineCreate(null);
      resetAsin();
      onClose();
    };
    // After the item exists: map the scraped supplier MPN(s) onto it (§4 alias mapping), then
    // attach any shared image (plan EI-4), then finish. Each step is best-effort — a failed alias
    // map or image attach still lets the create complete and the dialog close.
    const mapAliases = (itemId: string, next: () => void) => {
      const attachImage = () => {
        if (!initialImage || !itemId) return next();
        addImage.mutate({ itemId, file: initialImage }, { onSettled: next });
      };
      if (pendingAliases.length === 0) return attachImage();
      applyScrape.mutate(
        { id: itemId, write: { fields: {}, aliasAdditions: pendingAliases } },
        { onSettled: attachImage },
      );
    };

    // Path A2: persist the active-tab scrape's per-supplier pricing as an Amazon supplier
    // part (ASIN → order code, buy-box price → unit cost). §4 no-overwrite-safe — a fresh
    // item has no supplier rows, so this only ever *creates* one, never clobbers a value.
    const persistAmazonSupplier = (itemId: string, next: () => void) => {
      // A typed ASIN (this dialog's own field) takes precedence over an A2 active-tab scrape.
      const supplierPayload = asinPart ?? initialScrape;
      if (!supplierPayload || !itemId) return next();
      const write = resolveSupplierPartWrite(buildSupplierPartPlan(supplierPayload, []));
      if (write.kind !== 'create') return next();
      createSupplierPart.mutate({ itemId, input: write.input }, { onSettled: next });
    };

    // After the item exists: map any scraped aliases + attach a shared image, then persist an
    // Amazon supplier part (Path A2), then finish.
    const finish = (itemId: string) => mapAliases(itemId, () => persistAmazonSupplier(itemId, done));

    // Surface a create failure rather than swallowing it: without this the dialog would
    // sit silently open on any error (e.g. a `no such column` from a schema-stale local DB),
    // giving the user no signal that nothing was saved. The raw message is shown so the
    // cause is diagnosable; the dialog stays open so a corrected retry loses nothing.
    const onError = (e: unknown) =>
      show({
        tone: 'danger',
        heading: 'Couldn’t create item',
        message: e instanceof Error ? e.message : 'The item was not saved. Please try again.',
      });

    if (values.trackingMode === 'SERIALISED') {
      // Auto-clone N distinct instance records sharing a name (spec §4).
      const count = Math.max(1, Math.floor(Number(values.count) || 1));
      createSerialised.mutate(
        { ...base, count },
        { onSuccess: (items) => finish(items[0]?.id ?? ''), onError },
      );
      return;
    }

    let input: CreateItemInput = base;
    if (values.trackingMode === 'DISCRETE') {
      input = {
        ...base,
        quantity: Math.max(0, Math.floor(Number(values.quantity) || 0)),
        // "Unlimited supply" (Phase 82) — DISCRETE-only; the toggle is hidden for other modes.
        ...(values.isUnlimited ? { isUnlimited: true } : {}),
      };
    } else if (values.trackingMode === 'CONSUMABLE_GAUGE') {
      const net = values.currentNetValue?.trim() ? Number(values.currentNetValue) : undefined;
      input = {
        ...base,
        gauge: {
          unitOfMeasure: values.unitOfMeasure!.trim(),
          grossCapacity: Number(values.grossCapacity),
          tareWeight: Number(values.tareWeight) || 0,
          ...(net !== undefined ? { currentNetValue: net } : {}),
        },
      };
    }
    createItem.mutate(input, { onSuccess: (item) => finish(item.id), onError });
  };

  const resetAsin = () => {
    setAsinInput('');
    setAsinError(undefined);
    setAsinPart(null);
  };

  const handleClose = () => {
    reset();
    setPendingAliases([]);
    setInlineCreate(null);
    resetAsin();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add item"
      description="Create a new inventory item."
      initialFocusRef={nameRef}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="max-h-[78vh] space-y-4 dialog-scroll">
        <FormField
          label="Name"
          error={errors.name?.message}
          hintSize="md"
          hint={
            'The item’s display name — how it appears in lists, search and on labels.\n\n' +
            'Be **specific and consistent** so similar parts stay together:\n\n' +
            '| Prefer | Avoid |\n' +
            '| --- | --- |\n' +
            '| `M3 × 10 socket screws` | `screws` |\n' +
            '| `NE555 timer IC` | `chip` |\n\n' +
            '> Supplier part numbers go in **MPN** below, not here.'
          }
        >
          <Input
            placeholder="e.g. M3 × 10 socket screws"
            {...(() => {
              const { ref, ...rest } = register('name');
              return {
                ...rest,
                ref: (el: HTMLInputElement | null) => {
                  ref(el);
                  nameRef.current = el;
                },
              };
            })()}
          />
        </FormField>

        <FormField
          label="Description (optional)"
          hint={
            'What the item **is** — factual, display-worthy copy (e.g. a one-line datasheet ' +
            'summary). Searchable, and fillable by a supplier scrape.\n\nYour *own* remarks ' +
            'belong in **Notes** below.'
          }
        >
          <Textarea
            placeholder="e.g. Single bipolar timer IC, DIP-8"
            data-testid="item-description"
            {...register('description')}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          {/* A custom listbox (not a native <select>) so each row can show the location's
              colour swatch + item count; an implicit <label> can't name a role=combobox,
              so it is associated via labelledBy + a sibling label span (cf. MoveItemDialog). */}
          <div className="relative">
            <span id={locationLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
              Location
            </span>
            <span className="absolute right-0 top-0.5">
              <InfoHint
                content={
                  'Where this item physically lives. Locations are your storage tree — rooms, ' +
                  'cabinets, drawers, bins.\n\n' +
                  '- Pick the **most specific** place it sits.\n' +
                  '- **Unassigned** is the holding pen for items not yet shelved.\n' +
                  '- **In Transit** is for stock on its way in.\n\n' +
                  '> **Tip:** you can move it later, and split a quantity across several locations ' +
                  'from the item’s **Lifecycle** tab.'
                }
              />
            </span>
            <Controller
              control={control}
              name="locationId"
              render={({ field }) => (
                <LocationSelect
                  labelledBy={locationLabelId}
                  value={field.value}
                  onChange={(value) =>
                    value === CREATE_LOCATION_VALUE ? setInlineCreate('location') : field.onChange(value)
                  }
                  options={locationOptions}
                />
              )}
            />
            {errors.locationId?.message ? (
              <span role="alert" className="mt-1 block text-xs text-destructive">
                {errors.locationId.message}
              </span>
            ) : fullLocation ? (
              <span className="mt-1 block text-xs text-warning">
                {fullLocation.name} is at capacity ({fullLocation.itemCount}/{fullLocation.capacity}). You can
                still add here.
              </span>
            ) : null}
          </div>
          <Controller
            control={control}
            name="trackingMode"
            render={({ field }) => (
              <SelectField
                label="Tracking"
                hintSize="lg"
                hint={
                  'How this item’s stock is counted:\n\n' +
                  '| Mode | Counts | Example |\n' +
                  '| --- | --- | --- |\n' +
                  '| **Discrete** | a plain quantity | 100 screws |\n' +
                  '| **Serialised** | each unit separately | a table saw you check out |\n' +
                  '| **Consumable** | how *full* it is | a filament spool |\n' +
                  '| **Untracked** | presence only | a reference manual |\n\n' +
                  '> **One-off tool or asset?** A single item like a table saw is best **Serialised** ' +
                  'with a count of **1** — that gives it its own condition, servicing schedule, ' +
                  'check-out history and bookings. Use **Discrete** with quantity 1 only for a plain ' +
                  'countable thing you don’t need to track individually.\n\n' +
                  '> **Note:** **Serialised** and **Consumable** are fixed once set, so choose them ' +
                  'with care; **Discrete** and **Untracked** can be swapped later from the item’s ' +
                  'Details tab.'
                }
                options={TRACKING_MODES.map((mode) => ({ value: mode, label: TRACKING_MODE_LABELS[mode] }))}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>

        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <SelectField
              label="Category (optional)"
              hint={
                'Groups the item and unlocks **custom fields** specific to that category ' +
                '(e.g. *resistance* for resistors). Manage categories and their fields from the ' +
                'category manager, or pick **＋ New category…** to create one here. Leave as ' +
                '**None** if no category fits.'
              }
              options={[
                { value: '', label: '— None —' },
                ...(categories?.rows ?? []).map((cat) => ({ value: cat.id, label: cat.name })),
                { value: CREATE_CATEGORY_VALUE, label: '＋ New category…', kind: 'action' as const },
              ]}
              value={field.value ?? ''}
              onChange={(value) =>
                value === CREATE_CATEGORY_VALUE ? setInlineCreate('category') : field.onChange(value)
              }
            />
          )}
        />

        {/* §9 supplier scrape — rendered only when the companion extension is present. A shared
            URL (plan EI-4) pre-seeds the URL box so the draft can be enriched in one click. */}
        <ScrapeSupplierPanel onResult={onScrapeResult} initialUrl={initialValues?.sourceUrl} />

        {/* Add by ASIN / Amazon URL — the extension-free, network-free single-item path: paste a
            bare ASIN or a listing link and record an Amazon supplier part on create. Always
            available (unlike the extension-gated scrape panel above). */}
        <div className="space-y-field-gap-compact rounded-xl border border-border bg-secondary/20 p-3">
          <FormField
            label="Add by Amazon ASIN or link (optional)"
            error={asinError}
            hintSize="lg"
            hint={
              'Paste an **ASIN** (`B0F3XF5ZKF`) or an Amazon **listing link** ' +
              '(`amazon.co.uk/dp/…`) to record this item as an **Amazon supplier part** — the ' +
              'ASIN as its order code and a canonical listing link — with no extension and no ' +
              'network.\n\n> The item’s own fields are still yours to fill; nothing is overwritten.'
            }
          >
            <Input
              value={asinInput}
              onChange={(e) => {
                setAsinInput(e.target.value);
                if (asinError) setAsinError(undefined);
              }}
              placeholder="e.g. B0F3XF5ZKF or https://www.amazon.co.uk/dp/…"
              data-testid="item-asin"
            />
          </FormField>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyAsin}
              disabled={!asinInput.trim()}
              data-testid="item-asin-apply"
            >
              Record Amazon part
            </Button>
            {asinPart ? (
              <span role="status" className="text-xs text-muted-foreground" data-testid="item-asin-applied">
                Amazon supplier part ready: order code {asinPart.mpn}.
              </span>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="MPN (optional)"
            hintSize="lg"
            hint={
              'The **Manufacturer Part Number** — the maker’s canonical code for this part.\n\n' +
              '| Code type | Example | Stored as |\n' +
              '| --- | --- | --- |\n' +
              '| Manufacturer (MPN) | `NE555P` | this field |\n' +
              '| Distributor code | `1826764` | an **alias** |\n\n' +
              '> Used to de-duplicate items and to match supplier scrapes.'
            }
          >
            <Input placeholder="e.g. NE555P" {...register('mpn')} />
          </FormField>
          <Controller
            control={control}
            name="manufacturer"
            render={({ field }) => (
              <AutocompleteField
                label="Manufacturer (optional)"
                hint="Who makes the part (e.g. *Texas Instruments*). Helps distinguish otherwise identically-named parts from different makers. Type-ahead suggests makers already in your catalogue."
                value={field.value ?? ''}
                onChange={field.onChange}
                suggestions={manufacturerSuggestions ?? []}
                placeholder="e.g. Texas Instruments"
              />
            )}
          />
        </div>
        <FormField
          label="Barcode (optional)"
          hintSize="lg"
          hint={
            'The **retail barcode** (GTIN) printed on the packaging — EAN-13, UPC-A, EAN-8 or ' +
            'GTIN-14.\n\nScanning a product barcode pre-fills this automatically. It is the item’s ' +
            'own scannable code, distinct from the **MPN** above.\n\n> A future scan of the same ' +
            'barcode jumps straight to this item.'
          }
        >
          <Input
            inputMode="numeric"
            placeholder="e.g. 4006381333931"
            data-testid="item-barcode"
            {...register('barcode')}
          />
        </FormField>
        {/* Keyless product enrichment (recommendation point 2): when the companion extension
            is present and a barcode is entered, look the product up (Open Food Facts) and fill
            any blank name/description/manufacturer. Feature-detected — hidden when absent. */}
        <ProductLookupPanel barcode={watch('barcode') ?? ''} onResult={onProductLookup} />
        <FormField
          label="Unit cost (optional)"
          hint={
            'What **one unit** costs, in your base currency. Drives inventory valuation and ' +
            'project costing.\n\n> Enter the price *per unit*, not the total for a pack.'
          }
        >
          <Input type="number" min={0} step="any" placeholder="0.00" {...register('unitCost')} />
        </FormField>

        {/* Phase 9 — perishables, batch/lot & condition (§4). All optional. */}
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/20 p-3">
          <FormField
            label="Expiry date (optional)"
            hint={
              'When this stock expires or is best used by. Items nearing expiry surface on the ' +
              'dashboard **Soon to expire** widget so nothing quietly goes off.\n\nLeave blank for ' +
              'non-perishables.'
            }
          >
            <Input type="date" data-testid="item-expiry" {...register('expiryDate')} />
          </FormField>
          <Controller
            control={control}
            name="condition"
            render={({ field }) => (
              <SelectField
                label="Condition (optional)"
                hint={
                  'The physical state of this stock (e.g. *New*, *Used*, *Damaged*). **Untracked** ' +
                  'simply records no condition. Useful for second-hand or salvaged parts.'
                }
                data-testid="item-condition"
                options={conditionSelectOptions('— Untracked —')}
                value={field.value ?? ''}
                onChange={field.onChange}
              />
            )}
          />
          <FormField
            label="Batch no. (optional)"
            hint={
              'A maker/supplier **batch** identifier for traceability.\n\n' +
              '> Stock received under different batches is kept as separate lots and consumed ' +
              '**oldest-first (FEFO)**.'
            }
          >
            <Input placeholder="e.g. B-42" {...register('batchNumber')} />
          </FormField>
          <FormField
            label="Lot no. (optional)"
            hint="A finer **lot** identifier within a batch, when your supplier distinguishes the two. Optional — leave blank if you only track a batch."
          >
            <Input placeholder="e.g. L-7" {...register('lotNumber')} />
          </FormField>
        </div>

        {trackingMode === 'DISCRETE' ? (
          <>
            <FormField
              label="Initial quantity"
              hint={
                'How many units you have **on hand right now**. It seeds the stock ledger at the ' +
                'chosen location; you can adjust it later with moves, check-outs and cycle counts.\n\n' +
                '> Cataloguing a single one-off tool? A **Serialised** item (count 1) gives it its own ' +
                'condition, servicing and check-out history — see **Tracking** above.'
              }
            >
              <Input type="number" min={0} step={1} {...register('quantity')} />
            </FormField>
            {!isUnlimited ? (
              <LowStockAlertToggle
                register={register}
                enabled={lowStockAlert}
                onToggle={seedLowStockDefaults}
              >
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    label="Low-stock alert at"
                    hint={
                      'This item’s **own** low-stock trigger: it is flagged on the dashboard and ' +
                      'in reorder suggestions when on-hand quantity falls to or below this. Editable ' +
                      'later from the item’s **Supplier & ops** tab.'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      placeholder={`e.g. ${LOW_STOCK_QTY_SUGGESTED}`}
                      data-testid="item-reorder-point"
                      {...register('reorderPoint')}
                    />
                  </FormField>
                  <FormField
                    label="Reorder quantity (optional)"
                    hint={
                      'A suggested **top-up amount** for the shopping list when this item runs low. ' +
                      'Left blank, the shortfall back up to the low-stock level is used.'
                    }
                  >
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="Shortfall"
                      {...register('reorderQty')}
                    />
                  </FormField>
                </div>
              </LowStockAlertToggle>
            ) : null}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                data-testid="item-unlimited"
                {...register('isUnlimited')}
              />
              Unlimited supply
              <InfoHint
                content={
                  'Marks this as an **effectively infinite source** — tap water, mains air, a bulk ' +
                  'pile you never count.\n\nIts quantity shows as **∞**, it **never** runs low or ' +
                  'joins the shopping list, it is **excluded** from stock valuation and cycle ' +
                  'counts, and using it in a build never causes a shortage.'
                }
              />
            </label>
          </>
        ) : null}

        {trackingMode === 'SERIALISED' ? (
          <FormField
            label="How many (each becomes its own record)"
            hint={
              'Serialised items are tracked **individually**. Entering `3` creates **three separate ' +
              'records** sharing this name (e.g. *Drill #1, #2, #3*), each independently located, ' +
              'checked out and maintained.\n\n' +
              '> For a **single one-off asset** (e.g. a table saw), enter `1`.'
            }
          >
            <Input type="number" min={1} step={1} {...register('count')} />
          </FormField>
        ) : null}

        {trackingMode === 'CONSUMABLE_GAUGE' ? (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/20 p-3">
            <Controller
              control={control}
              name="unitOfMeasure"
              render={({ field }) => (
                <AutocompleteField
                  label="Unit"
                  error={errors.unitOfMeasure?.message}
                  hint="The unit the gauge is measured in — `g`, `ml`, `m`, etc. This labels the capacity and remaining amounts everywhere."
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  suggestions={unitSuggestions ?? []}
                  placeholder="g, ml, m…"
                />
              )}
            />
            <FormField
              label="Full capacity"
              error={errors.grossCapacity?.message}
              hint={
                'The **gross** amount a brand-new/full unit holds, in the unit above — including any ' +
                'container. The gauge reads *empty* at the tare and *full* here.'
              }
            >
              <Input type="number" min={0} step="any" {...register('grossCapacity')} />
            </FormField>
            <FormField
              label="Tare (empty)"
              hint={
                'The weight of the **empty container** (the spool, bottle or reel). Subtracted from a ' +
                'measured gross weight so the gauge reflects only the *usable contents*. Use `0` if not weighing.'
              }
            >
              <Input type="number" min={0} step="any" {...register('tareWeight')} />
            </FormField>
            <FormField
              label="Current (optional)"
              hint="How full it is **right now**, in the unit above. Leave blank to start at *full capacity*."
            >
              <Input type="number" min={0} step="any" placeholder="full" {...register('currentNetValue')} />
            </FormField>
          </div>
        ) : null}

        {trackingMode === 'CONSUMABLE_GAUGE' ? (
          <LowStockAlertToggle register={register} enabled={lowStockAlert} onToggle={seedLowStockDefaults}>
            <FormField
              label="Low-stock alert at (% left)"
              hint={
                'This consumable’s **own** low-stock trigger: it is flagged when its remaining ' +
                'percentage falls to or below this. Editable later from the item’s **Supplier & ops** tab.'
              }
            >
              <Input
                type="number"
                min={0}
                max={100}
                step={1}
                placeholder={`e.g. ${LOW_STOCK_GAUGE_SUGGESTED}`}
                data-testid="item-reorder-gauge"
                {...register('reorderGaugePercent')}
              />
            </FormField>
          </LowStockAlertToggle>
        ) : null}

        <FormField
          label="Notes (optional)"
          hint={
            'Your **own remarks** — provenance, quirks, reminders (e.g. *bought at the swap ' +
            'meet; pin 3 is bent*). Searchable, and editable later from the item’s **Details** tab.'
          }
        >
          <Textarea
            placeholder="Anything worth remembering about this item."
            data-testid="item-notes"
            {...register('notes')}
          />
        </FormField>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            Create item
          </Button>
        </div>
      </form>

      {/* Inline creation, stacked on top (the Modal stack scopes Escape/Tab to the top
          dialog). Mounted only while open so each opening starts fresh — and with the
          currently-chosen location as the suggested parent for a new location. On
          success the new entity is selected in the form; nothing typed is lost. */}
      {inlineCreate === 'location' ? (
        <CreateLocationDialog
          open
          onClose={() => setInlineCreate(null)}
          locations={locations}
          defaultParentId={
            chosenLocationId !== UNASSIGNED_LOCATION_ID && chosenLocationId !== IN_TRANSIT_LOCATION_ID
              ? chosenLocationId
              : undefined
          }
          onCreated={(location: Location) => setValue('locationId', location.id, { shouldDirty: true })}
        />
      ) : null}
      {inlineCreate === 'category' ? (
        <CreateCategoryDialog
          open
          onClose={() => setInlineCreate(null)}
          onCreated={(category: Category) => setValue('categoryId', category.id, { shouldDirty: true })}
        />
      ) : null}
    </Modal>
  );
}
