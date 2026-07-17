import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Controller, useForm, type Control, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AutocompleteField,
  Button,
  Checkbox,
  FormField,
  InfoHint,
  Input,
  MoneyInput,
  RailModal,
  SelectField,
  Spinner,
  Textarea,
  useToast,
  type RailTab,
} from '@/components/foundry';
import { DueDateIcon, EditIcon, ScanIcon, SupplierIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { hasOcr } from '@/lib/env/feature-detection';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { OcrPrefillDialog, type OcrPrefill } from '@/features/inventory/ocr/OcrPrefillDialog';
import { BarcodeScanDialog } from '@/features/scanner/components/BarcodeScanDialog';
import { useFeature } from '@/features/modules/useFeature';
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
import { valueForPolicy, type LowStockPolicy } from '../low-stock-policy';
import { LowStockPolicyPicker } from './LowStockPolicyPicker';
import { DEFAULT_AMAZON_MARKETPLACE, asinToUrl, marketplaceFromHost, parseAsin } from '../asin';
import { conditionSelectOptions, fromDateInputValue } from './inventory-ui';
import { warrantyExpiryFromWindow } from '../asset-lifecycle';
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
 *
 * Layout: the same left-rail / right-panel {@link RailModal} shell as the item
 * *editor* and Settings (§2.4.1), so adding and editing an item feel like one
 * surface. It stays a *single* form with one Create — the fields are simply
 * grouped into rail tabs (Details / Supplier & ops / Lifecycle) that mirror the
 * editor's, with the whole form spanning the panels (RHF keeps the values of an
 * unmounted tab, so switching tabs loses nothing) and the Create button pinned in
 * the rail footer. This keeps creation's own concerns — the permanent tracking-mode
 * choice, initial stock, supplier enrichment, and "nothing is saved until you
 * confirm" — that a per-facet-autosaving editor can't offer a not-yet-created item.
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
    acquiredAt: z.string().optional(),
    expiryDate: z.string().optional(),
    batchNumber: z.string().optional(),
    lotNumber: z.string().optional(),
    condition: z.string().optional(),
    // Warranty *window* in whole months (backlog T2). Soft-prefilled from a category default;
    // turned into an absolute `warrantyExpiresAt` (acquired-on, else today, + N months) at submit.
    warrantyMonths: z.string().optional(),
    quantity: z.string().optional(),
    count: z.string().optional(),
    unitOfMeasure: z.string().optional(),
    grossCapacity: z.string().optional(),
    tareWeight: z.string().optional(),
    currentNetValue: z.string().optional(),
    // Low-stock alert policy: follow the global default, a custom trigger, or never alert.
    // Only a 'custom' floor / 'never' exemption is submitted; 'default' leaves it unset.
    lowStockPolicy: z.enum(['default', 'custom', 'never']).optional(),
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

/** The rail tabs the create form is grouped into, mirroring the item editor's leading tabs. */
type CreateTabId = 'details' | 'supplier' | 'lifecycle';

/**
 * Which rail tab each field lives on — used to jump the rail to the tab holding the first
 * validation error when a submit is rejected, so an error is never left on an unmounted panel.
 * Every currently-validated field (name, location, gauge unit/capacity) sits on `details`;
 * the map still covers the others so the jump stays correct if validation is added later.
 * Only the perishables fields live on `lifecycle`; the supplier-enrichment panels have no
 * validated form field of their own.
 */
const FIELD_TAB: Record<string, CreateTabId> = {
  name: 'details',
  description: 'details',
  locationId: 'details',
  trackingMode: 'details',
  categoryId: 'details',
  mpn: 'details',
  manufacturer: 'details',
  barcode: 'details',
  unitCost: 'details',
  quantity: 'details',
  count: 'details',
  unitOfMeasure: 'details',
  grossCapacity: 'details',
  tareWeight: 'details',
  currentNetValue: 'details',
  isUnlimited: 'details',
  notes: 'details',
  lowStockPolicy: 'details',
  reorderPoint: 'details',
  reorderQty: 'details',
  reorderGaugePercent: 'details',
  acquiredAt: 'lifecycle',
  expiryDate: 'lifecycle',
  condition: 'lifecycle',
  warrantyMonths: 'lifecycle',
  batchNumber: 'lifecycle',
  lotNumber: 'lifecycle',
};

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

const DISCRETE_POLICY_HINT =
  'How this item is watched on the dashboard’s **Low Stock** list.\n\n' +
  '- **Default** — follow the global default in **Settings → Inventory** (off unless raised).\n' +
  '- **Custom** — flag it at or below your own on-hand quantity (set next).\n' +
  '- **Never** — a hard exemption: never flagged, even if a global default is switched on.';

const GAUGE_POLICY_HINT =
  'How this consumable is watched on the dashboard’s **Low Stock** list.\n\n' +
  '- **Default** — follow the global default in **Settings → Inventory** (off unless raised).\n' +
  '- **Custom** — flag it at or below your own percentage remaining (set next).\n' +
  '- **Never** — a hard exemption: never flagged, even if a global default is switched on.';

/**
 * The per-item low-stock alert policy for the Add-item dialog — the shared
 * {@link LowStockPolicyPicker} (Default / Custom / Never) so a new item can be created
 * already opted in, following the global default, or hard-exempted. Matches the item
 * editor's control exactly. The `children` (the custom-level trigger fields) are revealed
 * only when the policy is `'custom'`; `onSeedCustom` fills a suggested trigger so the
 * revealed field is never blank.
 */
function LowStockPolicyField({
  control,
  hint,
  policy,
  onSeedCustom,
  children,
}: {
  control: Control<FormValues>;
  hint: string;
  policy: LowStockPolicy;
  onSeedCustom: () => void;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="space-y-field-gap">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <span id={labelId}>Low-stock alerts</span>
        <InfoHint content={hint} />
      </div>
      <Controller
        control={control}
        name="lowStockPolicy"
        render={({ field }) => (
          <LowStockPolicyPicker
            value={(field.value as LowStockPolicy | undefined) ?? 'default'}
            onChange={(next) => {
              field.onChange(next);
              if (next === 'custom') onSeedCustom();
            }}
            labelledBy={labelId}
          />
        )}
      />
      {policy === 'custom' ? children : null}
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
  // Which rail tab is shown. Controlled here so a rejected submit can jump to the tab holding
  // the first validation error (see `onInvalid`), rather than leaving it on an unmounted panel.
  const [activeTab, setActiveTab] = useState<CreateTabId>('details');
  // On-device receipt/label OCR prefill (G2): opt-in + feature-detected. The scan dialog stacks
  // on top of this form and hands back reviewed values that fill only the still-blank fields.
  const [ocrOpen, setOcrOpen] = useState(false);
  const ocrEnabled = usePreferencesStore((s) => s.ocrEnabled);
  const showOcr = ocrEnabled && hasOcr();
  // Camera barcode capture for the Barcode field (issue #8): a "Scan" button beside the field
  // opens the shared scanner to fill the GTIN without typing. Gated by the same `scanner`
  // capability as the main scanner entry point (Modular UI) — with it off, the button is hidden;
  // the field can still be typed into. The dialog stacks on top of this form.
  const [barcodeScanOpen, setBarcodeScanOpen] = useState(false);
  const scannerEnabled = useFeature('scanner');
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
      acquiredAt: '',
      expiryDate: '',
      batchNumber: '',
      lotNumber: '',
      condition: '',
      warrantyMonths: '',
      quantity: '1',
      count: '1',
      unitOfMeasure: 'g',
      grossCapacity: '1000',
      tareWeight: '0',
      currentNetValue: '',
      lowStockPolicy: 'default',
      reorderPoint: '',
      reorderQty: '',
      reorderGaugePercent: '',
      isUnlimited: false,
    },
  });

  const trackingMode = watch('trackingMode');
  const lowStockPolicy = watch('lowStockPolicy') ?? 'default';
  const isUnlimited = watch('isUnlimited') ?? false;

  // Category-template soft prefill (backlog T1/T2): selecting a category whose default for a
  // facet is set fills that facet's field — but only until the user has touched it themselves.
  // Each ref is that field's dirty-check (mirroring the OCR/scrape "fill only the blank field"
  // idiom): flipped true on any manual change to its field, so a later category switch never
  // re-stomps a value the user chose. All reset alongside the form on close/create.
  //  · trackingModeTouched   — Tracking mode (T1).
  //  · conditionTouched      — Condition (T2).
  //  · warrantyMonthsTouched — Warranty window in months (T2).
  const trackingModeTouched = useRef(false);
  const conditionTouched = useRef(false);
  const warrantyMonthsTouched = useRef(false);

  // Choosing "Custom" seeds a friendly non-zero trigger so the user isn't left staring at a
  // blank required-feeling field (they can still change it). Only seeds when currently
  // empty, so re-selecting Custom never clobbers a value they've typed.
  const seedCustomTrigger = () => {
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

  // §4 no-overwrite: a reviewed on-device OCR scan (G2) fills only the fields the user has left
  // blank, exactly like the supplier scrape / barcode lookup above. The user has already vetted
  // every value in the scan dialog, so nothing here is a surprise; the serial has no dedicated
  // form field, so it's recorded in Notes (only when Notes is empty).
  const onOcrApply = (prefill: OcrPrefill) => {
    const v = getValues();
    const filled: string[] = [];
    if (prefill.unitCost && !v.unitCost?.trim()) {
      setValue('unitCost', prefill.unitCost, { shouldDirty: true });
      filled.push('unit cost');
    }
    if (prefill.acquiredAt && !v.acquiredAt?.trim()) {
      setValue('acquiredAt', prefill.acquiredAt, { shouldDirty: true });
      filled.push('acquired date');
    }
    if (prefill.mpn && !v.mpn?.trim()) {
      setValue('mpn', prefill.mpn, { shouldDirty: true });
      filled.push('MPN');
    }
    if (prefill.serial && !v.notes?.trim()) {
      setValue('notes', `Serial: ${prefill.serial}`, { shouldDirty: true });
      filled.push('serial (in notes)');
    }
    show({
      tone: filled.length > 0 ? 'success' : 'info',
      heading: filled.length > 0 ? 'Filled from your scan' : 'Nothing to fill',
      message:
        filled.length > 0
          ? `Filled ${filled.join(', ')}. Review before creating.`
          : 'Those fields already had values, so nothing was changed.',
    });
  };

  // "Add by ASIN / Amazon URL": parse the box (a bare ASIN or a `/dp/` listing link) via the
  // pure {@link parseAsin} seam. Invalid input surfaces an accessible error; a valid one
  // synthesises an Amazon supplier part — the ASIN as its order code, the canonical listing
  // URL as its link (marketplace derived from a pasted URL's host, else the locale default) —
  // recorded on create through the same §4 no-overwrite-safe path Path A2 uses. Fully offline
  // and non-destructive: no item field is touched, since the ASIN and listing URL are already
  // captured structurally on the supplier part (order code + link) — duplicating them into the
  // free-text Notes would be redundant and presumptuous.
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
  };

  const onSubmit = (values: FormValues) => {
    // Resolve the low-stock policy to the stored floor(s): 'default' → omit (null), 'never'
    // → 0 (hard exemption), 'custom' → the entered trigger. Unlimited / serialised / untracked
    // items never watch stock, so they carry no reorder fields.
    const policy = (values.lowStockPolicy ?? 'default') as LowStockPolicy;
    const reorderFields: { reorderPoint?: number; reorderQty?: number; reorderGaugePercent?: number } = {};
    if (values.trackingMode === 'CONSUMABLE_GAUGE') {
      const gp = valueForPolicy(
        policy,
        values.reorderGaugePercent?.trim() ? Number(values.reorderGaugePercent) : null,
      );
      if (gp != null) {
        reorderFields.reorderGaugePercent = gp;
      }
    } else if (values.trackingMode === 'DISCRETE' && !values.isUnlimited) {
      const rp = valueForPolicy(policy, values.reorderPoint?.trim() ? Number(values.reorderPoint) : null);
      if (rp != null) {
        reorderFields.reorderPoint = rp;
      }
      if (policy === 'custom' && values.reorderQty?.trim()) {
        reorderFields.reorderQty = Number(values.reorderQty);
      }
    }

    // Warranty window → absolute expiry (backlog T2): a whole-month window is measured from the
    // acquired-on date (else today), matching the category-template default's "N-month warranty".
    const warrantyExpiresAt = values.warrantyMonths?.trim()
      ? warrantyExpiryFromWindow(values.acquiredAt?.trim() || null, Number(values.warrantyMonths), Date.now())
      : null;

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
      // Acquisition date (§4, v24) — an ISO `YYYY-MM-DD` string; pre-fillable from a scanned receipt.
      ...(values.acquiredAt?.trim() ? { acquiredAt: values.acquiredAt.trim() } : {}),
      // Phase 9 perishables & condition (§4) — all optional.
      ...(values.expiryDate?.trim() ? { expiryDate: fromDateInputValue(values.expiryDate) } : {}),
      ...(values.batchNumber?.trim() ? { batchNumber: values.batchNumber.trim() } : {}),
      ...(values.lotNumber?.trim() ? { lotNumber: values.lotNumber.trim() } : {}),
      ...(values.condition ? { condition: values.condition as CreateItemInput['condition'] } : {}),
      // Warranty expiry derived from the months window above (backlog T2) — omitted when unset.
      ...(warrantyExpiresAt ? { warrantyExpiresAt } : {}),
      // Per-item low-stock policy (Phase 59 reorder policy) — resolved above.
      ...reorderFields,
    };
    const done = () => {
      reset();
      trackingModeTouched.current = false;
      conditionTouched.current = false;
      warrantyMonthsTouched.current = false;
      setPendingAliases([]);
      setInlineCreate(null);
      resetAsin();
      setActiveTab('details');
      setOcrOpen(false);
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

  // A rejected submit (Zod validation failed): jump the rail to the tab holding the first
  // errored field, so the error text isn't stranded on an unmounted panel while the user
  // stares at a Create button that "did nothing". The footer Create is visible on every tab.
  const onInvalid = (errs: FieldErrors<FormValues>) => {
    const firstField = Object.keys(errs)[0];
    const tab = firstField ? FIELD_TAB[firstField] : undefined;
    if (tab) setActiveTab(tab);
  };

  const resetAsin = () => {
    setAsinInput('');
    setAsinError(undefined);
    setAsinPart(null);
  };

  const handleClose = () => {
    reset();
    trackingModeTouched.current = false;
    conditionTouched.current = false;
    warrantyMonthsTouched.current = false;
    setPendingAliases([]);
    setInlineCreate(null);
    resetAsin();
    setActiveTab('details');
    onClose();
  };

  // The core identity + starting-stock fields — the rail's leading "Details" panel, mirroring
  // the item editor's Details tab.
  const detailsContent = (
    <>
      {/* On-device receipt/label OCR prefill (G2) — opt-in + feature-detected. Reads a photo
          entirely on the device and pre-fills a reviewable draft; it never auto-writes. */}
      {showOcr ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/20 p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOcrOpen(true)}
            data-testid="ocr-scan-trigger"
          >
            <ScanIcon aria-hidden />
            Scan a receipt or label
          </Button>
          <span className="text-xs text-muted-foreground">
            Pre-fill price, date, model and serial from a photo — on-device, then review.
          </span>
        </div>
      ) : null}

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
                '| **Bulk** | a plain quantity | 100 screws |\n' +
                '| **Serialised** | each unit separately | a table saw you check out |\n' +
                '| **Consumable** | how *full* it is | a filament spool |\n' +
                '| **Untracked** | presence only | a reference manual |\n\n' +
                '> **One-off tool or asset?** A single item like a table saw is best **Serialised** ' +
                'with a count of **1** — that gives it its own condition, servicing schedule, ' +
                'check-out history and bookings. Use **Bulk** with quantity 1 only for a plain ' +
                'countable thing you don’t need to track individually.\n\n' +
                '> **Note:** **Serialised** and **Consumable** are fixed once set, so choose them ' +
                'with care; **Bulk** and **Untracked** can be swapped later from the item’s ' +
                'Details tab.'
              }
              options={TRACKING_MODES.map((mode) => ({ value: mode, label: TRACKING_MODE_LABELS[mode] }))}
              value={field.value}
              onChange={(value) => {
                // A manual pick disables the category-default soft prefill (backlog T1) from here
                // on, so switching category later never re-stomps the mode the user chose.
                trackingModeTouched.current = true;
                field.onChange(value);
              }}
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
            onChange={(value) => {
              if (value === CREATE_CATEGORY_VALUE) {
                setInlineCreate('category');
                return;
              }
              field.onChange(value);
              // Category-template soft prefill (backlog T1/T2): adopt the chosen category's
              // defaults for each lifecycle facet, but only while the user hasn't touched that
              // facet's field themselves — so switching category never re-stomps a manual value.
              const cat = categories?.rows.find((c) => c.id === value);
              if (cat && !trackingModeTouched.current && cat.defaultTrackingMode) {
                setValue('trackingMode', cat.defaultTrackingMode);
              }
              if (cat && !conditionTouched.current && cat.defaultCondition) {
                setValue('condition', cat.defaultCondition);
              }
              if (cat && !warrantyMonthsTouched.current && cat.defaultWarrantyMonths != null) {
                setValue('warrantyMonths', String(cat.defaultWarrantyMonths));
              }
            }}
          />
        )}
      />

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
      {/* The Scan button sits beside the field (issue #8) but *outside* the FormField's
          `<label>` — so it never folds into the input's accessible name and clicking it can't be
          mistaken for the label. `items-end` bottom-aligns it with the input (both h-10). */}
      <div className="flex items-end gap-2">
        <FormField
          className="flex-1"
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
        {scannerEnabled ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setBarcodeScanOpen(true)}
            data-testid="item-barcode-scan"
          >
            <ScanIcon aria-hidden />
            Scan
          </Button>
        ) : null}
      </div>
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
        <Controller
          control={control}
          name="unitCost"
          render={({ field }) => (
            <MoneyInput
              ref={field.ref}
              value={field.value ?? ''}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              placeholder="0.00"
            />
          )}
        />
      </FormField>

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
            <LowStockPolicyField
              control={control}
              hint={DISCRETE_POLICY_HINT}
              policy={lowStockPolicy}
              onSeedCustom={seedCustomTrigger}
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
                    min={1}
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
                  <Input type="number" min={0} step={1} placeholder="Shortfall" {...register('reorderQty')} />
                </FormField>
              </div>
            </LowStockPolicyField>
          ) : null}
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox data-testid="item-unlimited" {...register('isUnlimited')} />
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
        <LowStockPolicyField
          control={control}
          hint={GAUGE_POLICY_HINT}
          policy={lowStockPolicy}
          onSeedCustom={seedCustomTrigger}
        >
          <FormField
            label="Low-stock alert at (% left)"
            hint={
              'This consumable’s **own** low-stock trigger: it is flagged when its remaining ' +
              'percentage falls to or below this. Editable later from the item’s **Supplier & ops** tab.'
            }
          >
            <Input
              type="number"
              min={1}
              max={100}
              step={1}
              placeholder={`e.g. ${LOW_STOCK_GAUGE_SUGGESTED}`}
              data-testid="item-reorder-gauge"
              {...register('reorderGaugePercent')}
            />
          </FormField>
        </LowStockPolicyField>
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
    </>
  );

  // Supplier & ops — the supplier-enrichment tools that record a supplier part on the new item:
  // the extension-gated live scrape, and the extension-free, network-free "add by ASIN" path.
  // Both fill the item's own fields on the Details tab through the §4 no-overwrite-safe path.
  const supplierContent = (
    <>
      {/* §9 supplier scrape — rendered only when the companion extension is present. A shared
            URL (plan EI-4) pre-seeds the URL box so the draft can be enriched in one click. */}
      <ScrapeSupplierPanel onResult={onScrapeResult} initialUrl={initialValues?.sourceUrl} />

      {/* Add by ASIN / Amazon URL — the extension-free, network-free single-item path: paste a
            bare ASIN or a listing link and record an Amazon supplier part on create. Always
            available (unlike the extension-gated scrape panel above). It records the supplier
            part *only* — it can't read the listing (a web app is blocked from fetching Amazon by
            the browser's cross-origin rules), so the item's own name/brand/price aren't filled;
            the hint steers the user to Share-to-Gubbins or the extension for that. */}
      <div className="space-y-field-gap-compact rounded-xl border border-border bg-secondary/20 p-3">
        <FormField
          label="Record as an Amazon supplier part (optional)"
          error={asinError}
          hintSize="lg"
          hint={
            'Paste an **ASIN** (`B0F3XF5ZKF`) or an Amazon **listing link** ' +
            '(`amazon.co.uk/dp/…`) to record this item as an **Amazon supplier part** — the ASIN ' +
            'as its order code plus a canonical listing link.\n\n' +
            '**This does not read the listing**, so the item’s name, brand and price aren’t ' +
            'filled in — a web app is blocked from fetching Amazon’s pages directly. To pull ' +
            'those in from the listing:\n\n' +
            '- **Share it to Gubbins** — open the listing in your browser and choose *Share → ' +
            'Gubbins*. The name comes across, no extension needed.\n' +
            '- Install the **companion browser extension** to auto-fill the name, brand and ' +
            'price from the Amazon tab you have open.\n\n' +
            '> Either way nothing you’ve typed is overwritten.'
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
              Supplier part ready — order code {asinPart.mpn}. The name and price are still yours to fill (or
              share the listing to Gubbins to auto-fill the name).
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  // Lifecycle — Phase 9 perishables, batch/lot & condition (§4). All optional.
  const lifecycleContent = (
    <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/20 p-3">
      <FormField
        label="Acquired date (optional)"
        hint={
          'When you **acquired** this item (bought, received or was given it). Feeds warranty, ' +
          'depreciation and the insurance schedule.\n\nScanning a receipt can fill this for you.'
        }
      >
        <Input type="date" data-testid="item-acquired" {...register('acquiredAt')} />
      </FormField>
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
              'simply records no condition. Useful for second-hand or salvaged parts.\n\n' +
              'A category can pre-fill this — you can still change it here.'
            }
            data-testid="item-condition"
            options={conditionSelectOptions('— Untracked —')}
            value={field.value ?? ''}
            onChange={(value) => {
              // A manual pick disables the category-default soft prefill (backlog T2) from here
              // on, so switching category later never re-stomps the condition the user chose.
              conditionTouched.current = true;
              field.onChange(value);
            }}
          />
        )}
      />
      <FormField
        label="Warranty (months, optional)"
        hint={
          'How long this item is under warranty, in **whole months**. On create this is turned ' +
          'into a warranty **expiry date** measured from the *Acquired date* above (or today, if ' +
          'that is blank) — so a *12* here on an item acquired today expires in a year.\n\n' +
          'A category can pre-fill this for its items; leave blank for no warranty. You can set an ' +
          'exact expiry date later from the item’s **Asset** details.'
        }
      >
        <Input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          placeholder="e.g. 12"
          data-testid="item-warranty-months"
          {...register('warrantyMonths', {
            // A manual edit disables the category-default soft prefill (backlog T2) from here on.
            onChange: () => {
              warrantyMonthsTouched.current = true;
            },
          })}
        />
      </FormField>
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
  );

  // The rail's three tabs, mirroring the item editor's leading tabs (Details / Supplier & ops /
  // Lifecycle). The whole create form spans them (RHF keeps an unmounted tab's values), so
  // switching tabs never loses input and the single footer Create submits everything at once.
  const tabs: readonly RailTab[] = [
    { id: 'details', label: 'Details', icon: <EditIcon />, content: detailsContent },
    { id: 'supplier', label: 'Supplier & ops', icon: <SupplierIcon />, content: supplierContent },
    { id: 'lifecycle', label: 'Lifecycle', icon: <DueDateIcon />, content: lifecycleContent },
  ];

  return (
    <>
      <RailModal
        open={open}
        onClose={handleClose}
        title="Add item"
        description="Create a new inventory item."
        className="max-w-4xl"
        railAriaLabel="Item sections"
        idPrefix="create-item"
        tabs={tabs}
        activeTabId={activeTab}
        onActiveTabChange={(id) => setActiveTab(id as CreateTabId)}
        onSubmit={handleSubmit(onSubmit, onInvalid)}
        initialFocusRef={nameRef}
        footer={
          <>
            {/* Progress feedback while the create is in flight (issue #57): a disabled Create
                button alone doesn't tell the user anything is happening. This status label sits
                to the left of the buttons (mr-auto) and is announced politely to assistive tech. */}
            {isPending ? (
              <span
                role="status"
                aria-live="polite"
                className="mr-auto flex items-center gap-2 text-sm text-muted-foreground"
                data-testid="create-item-status"
              >
                <Spinner className="size-4" decorative />
                Creating item…
              </span>
            ) : null}
            <Button type="button" variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              Create item
            </Button>
          </>
        }
      />

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

      {/* On-device OCR scan (G2), stacked on top of this form. Mounted only while open so each
          scan starts fresh; on Apply it fills only the blank fields via `onOcrApply`. */}
      {ocrOpen ? <OcrPrefillDialog open onClose={() => setOcrOpen(false)} onApply={onOcrApply} /> : null}

      {/* Camera barcode capture (issue #8), stacked on top of this form. A decoded barcode fills
          the Barcode field directly (it *is* an explicit user action, so it overwrites); the
          keyless product lookup below the field then reacts to the new value on its own. */}
      <BarcodeScanDialog
        open={barcodeScanOpen}
        onClose={() => setBarcodeScanOpen(false)}
        onCapture={(barcode) => setValue('barcode', barcode, { shouldDirty: true })}
      />
    </>
  );
}
