import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Input, Modal, Select } from '@/components/foundry';
import {
  TRACKING_MODES,
  UNASSIGNED_LOCATION_ID,
  type CreateItemInput,
  type LocationWithCount,
  type TrackingMode,
} from '@/db/repositories';
import {
  applyScrapeMerge,
  buildScrapeMergePlan,
  ScrapeSupplierPanel,
  useScrapeNotifier,
  type ScrapeResultPayload,
} from '@/features/scraping';
import { useCategories } from '../categories';
import { useApplyScrape, useCreateItem, useCreateSerialisedItems } from '../mutations';
import { TRACKING_MODE_LABELS } from './inventory-ui';

/**
 * Item creation form (spec §2.4.4) — React Hook Form bound to a Zod schema via
 * @hookform/resolvers/zod, so validation runs without re-rendering on every
 * keystroke. The gauge fields appear only for CONSUMABLE_GAUGE items (§4.1.1).
 */
const schema = z
  .object({
    name: z.string().trim().min(1, 'Please enter a name.'),
    locationId: z.string().min(1, 'Please choose a location.'),
    categoryId: z.string().optional(),
    trackingMode: z.enum(TRACKING_MODES),
    mpn: z.string().optional(),
    manufacturer: z.string().optional(),
    unitCost: z.string().optional(),
    quantity: z.string().optional(),
    count: z.string().optional(),
    unitOfMeasure: z.string().optional(),
    grossCapacity: z.string().optional(),
    tareWeight: z.string().optional(),
    currentNetValue: z.string().optional(),
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

export function CreateItemDialog({
  open,
  onClose,
  locations,
  defaultLocationId,
}: {
  open: boolean;
  onClose: () => void;
  locations: readonly LocationWithCount[];
  defaultLocationId?: string;
}) {
  const createItem = useCreateItem();
  const createSerialised = useCreateSerialisedItems();
  const applyScrape = useApplyScrape();
  const notifyScrape = useScrapeNotifier();
  const { data: categories } = useCategories();
  // Supplier MPNs to map onto the new item as aliases once it is created (§4).
  const [pendingAliases, setPendingAliases] = useState<readonly string[]>([]);
  const {
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
      name: '',
      locationId: defaultLocationId ?? UNASSIGNED_LOCATION_ID,
      categoryId: '',
      trackingMode: 'DISCRETE',
      mpn: '',
      manufacturer: '',
      unitCost: '',
      quantity: '1',
      count: '1',
      unitOfMeasure: 'g',
      grossCapacity: '1000',
      tareWeight: '0',
      currentNetValue: '',
    },
  });

  const trackingMode = watch('trackingMode') as TrackingMode;
  const isPending = createItem.isPending || createSerialised.isPending;

  // §4 no-overwrite: a scrape only fills fields the user has left blank on the form.
  const onScrapeResult = (payload: ScrapeResultPayload) => {
    const v = getValues();
    const plan = buildScrapeMergePlan(
      {
        mpn: v.mpn?.trim() || null,
        manufacturer: v.manufacturer?.trim() || null,
        description: null,
        unitCost: v.unitCost?.trim() ? Number(v.unitCost) : null,
        aliases: [],
      },
      payload,
    );
    const write = applyScrapeMerge(plan); // FILL fields only — no opt-in overwrites here
    const filled: string[] = [];
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
    notifyScrape(filled.length > 0 ? `Filled ${filled.join(', ')} from ${host}.` : `No empty fields to fill from ${host}.`);
  };

  const onSubmit = (values: FormValues) => {
    const base = {
      name: values.name.trim(),
      locationId: values.locationId,
      categoryId: values.categoryId ? values.categoryId : undefined,
      trackingMode: values.trackingMode,
      ...(values.mpn?.trim() ? { mpn: values.mpn.trim() } : {}),
      ...(values.manufacturer?.trim() ? { manufacturer: values.manufacturer.trim() } : {}),
      ...(values.unitCost?.trim() ? { unitCost: Number(values.unitCost) } : {}),
    };
    const done = () => {
      reset();
      setPendingAliases([]);
      onClose();
    };
    // Map the scraped supplier MPN(s) onto the freshly-created item (§4 alias mapping).
    const mapAliases = (itemId: string, next: () => void) => {
      if (pendingAliases.length === 0) return next();
      applyScrape.mutate(
        { id: itemId, write: { fields: {}, aliasAdditions: pendingAliases } },
        { onSettled: next },
      );
    };

    if (values.trackingMode === 'SERIALISED') {
      // Auto-clone N distinct instance records sharing a name (spec §4).
      const count = Math.max(1, Math.floor(Number(values.count) || 1));
      createSerialised.mutate(
        { ...base, count },
        { onSuccess: (items) => mapAliases(items[0]?.id ?? '', done) },
      );
      return;
    }

    let input: CreateItemInput = base;
    if (values.trackingMode === 'DISCRETE') {
      input = { ...base, quantity: Math.max(0, Math.floor(Number(values.quantity) || 0)) };
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
    createItem.mutate(input, { onSuccess: (item) => mapAliases(item.id, done) });
  };

  const handleClose = () => {
    reset();
    setPendingAliases([]);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Add item" description="Create a new inventory item.">
      <form onSubmit={handleSubmit(onSubmit)} className="max-h-[78vh] space-y-4 overflow-y-auto pr-1">
        <Field label="Name" error={errors.name?.message}>
          <Input autoFocus placeholder="e.g. M3 × 10 socket screws" {...register('name')} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Location" error={errors.locationId?.message}>
            <Select {...register('locationId')}>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tracking">
            <Select {...register('trackingMode')}>
              {TRACKING_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {TRACKING_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Category (optional)">
          <Select {...register('categoryId')}>
            <option value="">— None —</option>
            {(categories?.rows ?? []).map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </Select>
        </Field>

        {/* §9 supplier scrape — rendered only when the companion extension is present. */}
        <ScrapeSupplierPanel onResult={onScrapeResult} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="MPN (optional)">
            <Input placeholder="e.g. NE555P" {...register('mpn')} />
          </Field>
          <Field label="Manufacturer (optional)">
            <Input placeholder="e.g. Texas Instruments" {...register('manufacturer')} />
          </Field>
        </div>
        <Field label="Unit cost (optional)">
          <Input type="number" min={0} step="any" placeholder="0.00" {...register('unitCost')} />
        </Field>

        {trackingMode === 'DISCRETE' ? (
          <Field label="Initial quantity">
            <Input type="number" min={0} step={1} {...register('quantity')} />
          </Field>
        ) : null}

        {trackingMode === 'SERIALISED' ? (
          <Field label="How many (each becomes its own record)">
            <Input type="number" min={1} step={1} {...register('count')} />
          </Field>
        ) : null}

        {trackingMode === 'CONSUMABLE_GAUGE' ? (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/20 p-3">
            <Field label="Unit" error={errors.unitOfMeasure?.message}>
              <Input placeholder="g, ml, m…" {...register('unitOfMeasure')} />
            </Field>
            <Field label="Full capacity" error={errors.grossCapacity?.message}>
              <Input type="number" min={0} step="any" {...register('grossCapacity')} />
            </Field>
            <Field label="Tare (empty)">
              <Input type="number" min={0} step="any" {...register('tareWeight')} />
            </Field>
            <Field label="Current (optional)">
              <Input type="number" min={0} step="any" placeholder="full" {...register('currentNetValue')} />
            </Field>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isPending}>
            Create item
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-destructive">{error}</span> : null}
    </label>
  );
}
