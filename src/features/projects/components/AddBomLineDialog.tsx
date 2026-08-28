import { Controller, useForm } from 'react-hook-form';
import { TEXT_LIMITS, withinTextLimit } from '@/lib/text-limits';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AutocompleteField, Button, FormField, Input, Modal } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { ItemPicker } from '@/features/inventory/components/ItemPicker';
import { TRACKING_MODE_LABELS } from '@/features/inventory/components/inventory-ui';
import { useFieldSuggestions } from '@/features/inventory/queries';
import { receiptLandingFor } from '../receipts';
import { useAddBomLine } from '../projects';

/**
 * Manual BOM-line entry (spec §4 BOM Ingress — Manual Entry). A line may be matched
 * to an existing inventory item (inheriting its cost snapshot) or left as a free
 * description with an MPN/manufacturer for later auto-matching.
 */
const schema = z.object({
  itemId: z.string().optional(),
  designator: z.string().refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.').optional(),
  description: z.string().refine(withinTextLimit(TEXT_LIMITS.note), 'That entry is too long.').optional(),
  mpn: z.string().refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.').optional(),
  manufacturer: z.string().refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.').optional(),
  requiredQty: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

/**
 * How a candidate item is named in the picker. An item whose tracking mode holds no counted
 * quantity is named as such (issue #608): it stays matchable, so the BOM can still require a
 * serialised tool or a consumable, but the label no longer implies that receiving the line will
 * move that item's stock — it cannot.
 */
function bomItemLabel(item: Item): string {
  const suffix =
    receiptLandingFor(item.trackingMode) === 'RECORD_ONLY'
      ? ` · ${TRACKING_MODE_LABELS[item.trackingMode]} — no stock movement`
      : '';
  return `${item.name}${item.mpn ? ` · ${item.mpn}` : ''}${suffix}`;
}

export function AddBomLineDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const addLine = useAddBomLine(projectId);
  const { data: manufacturerSuggestions } = useFieldSuggestions('manufacturer');
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      itemId: '',
      designator: '',
      description: '',
      mpn: '',
      manufacturer: '',
      requiredQty: '1',
    },
  });

  const close = () => {
    reset();
    onClose();
  };

  const onSubmit = (values: FormValues) => {
    const text = (v?: string) => (v?.trim() ? v.trim() : undefined);
    if (!values.itemId && !text(values.description) && !text(values.mpn) && !text(values.designator)) {
      // Mirror the repository invariant in the form so the user gets feedback.
      reset(values);
      return;
    }
    addLine.mutate(
      {
        itemId: values.itemId || null,
        designator: text(values.designator) ?? null,
        description: text(values.description) ?? null,
        mpn: text(values.mpn) ?? null,
        manufacturer: text(values.manufacturer) ?? null,
        requiredQty: Math.max(1, Math.floor(Number(values.requiredQty) || 1)),
      },
      { onSuccess: close },
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add BOM line"
      description="Add a required part to this project."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <Controller
            control={control}
            name="itemId"
            render={({ field }) => (
              <ItemPicker
                label="Inventory item (optional)"
                value={field.value ?? ''}
                onChange={(id) => field.onChange(id ?? '')}
                labelFor={bomItemLabel}
                placeholder="Type to search — or leave blank for a manual line"
              />
            )}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            Matching an item inherits its current unit cost as the point-in-time snapshot.
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Designator">
            <Input placeholder="R1, R2" {...register('designator')} />
          </FormField>
          <FormField label="Quantity" error={errors.requiredQty?.message}>
            <Input type="number" min={1} step={1} {...register('requiredQty')} />
          </FormField>
        </div>

        <FormField label="Description">
          <Input placeholder="e.g. 10k 0805 resistor" {...register('description')} />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="MPN">
            <Input placeholder="RC0805FR-0710KL" {...register('mpn')} />
          </FormField>
          <Controller
            control={control}
            name="manufacturer"
            render={({ field }) => (
              <AutocompleteField
                label="Manufacturer"
                value={field.value ?? ''}
                onChange={field.onChange}
                suggestions={manufacturerSuggestions ?? []}
                placeholder="Yageo"
              />
            )}
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={addLine.isPending}>
            Add line
          </Button>
        </div>
      </form>
    </Modal>
  );
}
