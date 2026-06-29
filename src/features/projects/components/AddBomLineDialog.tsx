import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, FormField, Input, Modal, Select } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { useAddBomLine } from '../projects';

/**
 * Manual BOM-line entry (spec §4 BOM Ingress — Manual Entry). A line may be matched
 * to an existing inventory item (inheriting its cost snapshot) or left as a free
 * description with an MPN/manufacturer for later auto-matching.
 */
const schema = z.object({
  itemId: z.string().optional(),
  designator: z.string().optional(),
  description: z.string().optional(),
  mpn: z.string().optional(),
  manufacturer: z.string().optional(),
  requiredQty: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

export function AddBomLineDialog({
  open,
  onClose,
  projectId,
  items,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  items: readonly Item[];
}) {
  const addLine = useAddBomLine(projectId);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { itemId: '', designator: '', description: '', mpn: '', manufacturer: '', requiredQty: '1' },
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
    <Modal open={open} onClose={close} title="Add BOM line" description="Add a required part to this project.">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Inventory item (optional)</span>
          <Select {...register('itemId')}>
            <option value="">— Manual / unmatched —</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.mpn ? ` · ${item.mpn}` : ''}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Matching an item inherits its current unit cost as the point-in-time snapshot.
          </span>
        </label>

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
          <FormField label="Manufacturer">
            <Input placeholder="Yageo" {...register('manufacturer')} />
          </FormField>
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
