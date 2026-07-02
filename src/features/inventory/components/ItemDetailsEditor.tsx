import { useEffect, useState } from 'react';
import { Button, FormField, Input, Select, Textarea } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { useCategories } from '../categories';
import { useUpdateItem } from '../mutations';

/**
 * Core-fields editor — the "Edit item" home for the identity fields set when the
 * item was created: name, description, the owner's notes, MPN, manufacturer, unit
 * cost and category. Everything else already has a dedicated facet editor
 * (lifecycle, reorder point, supplier data, …), so this deliberately covers only
 * the fields that previously could not be changed after creation.
 *
 * Draft state is local and saved wholesale via {@link useUpdateItem} (which logs a
 * `RENAMED` history entry when the name changes). Blank optional fields clear the
 * stored value back to null.
 */
export function ItemDetailsEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const { data: categories } = useCategories();

  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [mpn, setMpn] = useState(item.mpn ?? '');
  const [manufacturer, setManufacturer] = useState(item.manufacturer ?? '');
  const [unitCost, setUnitCost] = useState(item.unitCost?.toString() ?? '');
  const [categoryId, setCategoryId] = useState(item.categoryId ?? '');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    setName(item.name);
    setDescription(item.description ?? '');
    setNotes(item.notes ?? '');
    setMpn(item.mpn ?? '');
    setManufacturer(item.manufacturer ?? '');
    setUnitCost(item.unitCost?.toString() ?? '');
    setCategoryId(item.categoryId ?? '');
  }, [item]);

  const text = (raw: string): string | null => (raw.trim().length > 0 ? raw.trim() : null);
  const nextUnitCost = unitCost.trim() === '' ? null : Number(unitCost);
  const draft = {
    name: name.trim(),
    description: text(description),
    notes: text(notes),
    mpn: text(mpn),
    manufacturer: text(manufacturer),
    unitCost: Number.isFinite(nextUnitCost ?? 0) ? nextUnitCost : null,
    categoryId: categoryId || null,
  };
  const dirty =
    draft.name !== item.name ||
    draft.description !== (item.description ?? null) ||
    draft.notes !== (item.notes ?? null) ||
    draft.mpn !== (item.mpn ?? null) ||
    draft.manufacturer !== (item.manufacturer ?? null) ||
    draft.unitCost !== (item.unitCost ?? null) ||
    draft.categoryId !== (item.categoryId ?? null);
  const valid = draft.name.length > 0;

  const save = () => update.mutate({ id: item.id, input: draft });

  return (
    <div className="space-y-3">
      <FormField
        label="Name"
        error={valid ? undefined : 'Please enter a name.'}
        hint="The item’s display name — how it appears in lists, search and on labels. Renames are recorded in the activity log."
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="item-details-name" />
      </FormField>

      <FormField
        label="Description (optional)"
        hint="What the item **is** — factual, display-worthy copy (e.g. a one-line datasheet summary). Searchable."
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Single bipolar timer IC, DIP-8"
          data-testid="item-details-description"
        />
      </FormField>

      <FormField
        label="Notes (optional)"
        hint="Your **own remarks** — provenance, quirks, reminders (e.g. *bought at the swap meet; pin 3 is bent*). Searchable."
      >
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth remembering about this item."
          data-testid="item-details-notes"
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="MPN (optional)" hint="The Manufacturer Part Number — the maker’s canonical code for this part.">
          <Input value={mpn} onChange={(e) => setMpn(e.target.value)} placeholder="e.g. NE555P" />
        </FormField>
        <FormField label="Manufacturer (optional)" hint="Who makes the part (e.g. *Texas Instruments*).">
          <Input
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            placeholder="e.g. Texas Instruments"
          />
        </FormField>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Unit cost (optional)"
          hint={
            'What **one unit** costs, in your base currency. Drives valuation and project ' +
            'costing.\n\nWhen set, this **manual** cost overrides the preferred supplier’s price; ' +
            'leave it blank to use the preferred supplier from the **Supplier & ops** tab.'
          }
        >
          <Input
            type="number"
            min={0}
            step="any"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            placeholder="0.00"
          />
        </FormField>
        <FormField
          label="Category"
          hint="Groups the item and unlocks that category’s **custom fields**. *None* leaves it uncategorised."
        >
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">— None —</option>
            {(categories?.rows ?? []).map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || !valid || update.isPending}
          data-testid="item-details-save"
        >
          {dirty ? 'Save details' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
