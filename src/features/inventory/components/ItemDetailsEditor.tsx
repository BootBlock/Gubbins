import { useEffect, useState } from 'react';
import { Button, FormField, Input, Select, Textarea } from '@/components/foundry';
import { CONVERTIBLE_TRACKING_MODES, type Item, type TrackingMode } from '@/db/repositories';
import { useCategories } from '../categories';
import { useUpdateItem } from '../mutations';
import { TRACKING_MODE_LABELS } from './inventory-ui';

/** Whether this item's tracking mode is one that can be switched in place (Bulk ↔ Untracked). */
const isTrackingEditable = (mode: TrackingMode): boolean =>
  (CONVERTIBLE_TRACKING_MODES as readonly TrackingMode[]).includes(mode);

/**
 * Core-fields editor — the "Edit item" home for the identity fields set when the
 * item was created: name, description, the owner's notes, MPN, manufacturer, unit
 * cost, category and (for the Bulk ↔ Untracked pair only) the tracking mode.
 * Everything else already has a dedicated facet editor (lifecycle, reorder point,
 * supplier data, …), so this deliberately covers only the fields that previously
 * could not be changed after creation.
 *
 * Draft state is local and saved wholesale via {@link useUpdateItem} (which logs a
 * `RENAMED` history entry when the name changes). Blank optional fields clear the
 * stored value back to null.
 */
export function ItemDetailsEditor({ item }: { item: Item }) {
  const update = useUpdateItem();
  const { data: categories } = useCategories();

  const [name, setName] = useState(item.name);
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(item.trackingMode);
  const [description, setDescription] = useState(item.description ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [mpn, setMpn] = useState(item.mpn ?? '');
  const [manufacturer, setManufacturer] = useState(item.manufacturer ?? '');
  const [unitCost, setUnitCost] = useState(item.unitCost?.toString() ?? '');
  const [categoryId, setCategoryId] = useState(item.categoryId ?? '');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    setName(item.name);
    setTrackingMode(item.trackingMode);
    setDescription(item.description ?? '');
    setNotes(item.notes ?? '');
    setMpn(item.mpn ?? '');
    setManufacturer(item.manufacturer ?? '');
    setUnitCost(item.unitCost?.toString() ?? '');
    setCategoryId(item.categoryId ?? '');
  }, [item]);

  const text = (raw: string): string | null => (raw.trim().length > 0 ? raw.trim() : null);
  const nextUnitCost = unitCost.trim() === '' ? null : Number(unitCost);
  // Serialised / Consumable-Gauge items can't be converted in place, so their mode is fixed
  // and never enters the draft; only the Bulk ↔ Untracked pair is editable here.
  const trackingEditable = isTrackingEditable(item.trackingMode);
  const draft = {
    name: name.trim(),
    ...(trackingEditable ? { trackingMode } : {}),
    description: text(description),
    notes: text(notes),
    mpn: text(mpn),
    manufacturer: text(manufacturer),
    unitCost: Number.isFinite(nextUnitCost ?? 0) ? nextUnitCost : null,
    categoryId: categoryId || null,
  };
  const dirty =
    draft.name !== item.name ||
    (trackingEditable && trackingMode !== item.trackingMode) ||
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
        <FormField
          label="MPN (optional)"
          hint="The Manufacturer Part Number — the maker’s canonical code for this part."
        >
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

      <div className="grid gap-3 sm:grid-cols-2">
        {trackingEditable ? (
          <FormField
            label="Tracking"
            hint={
              'How this item’s stock is counted. **Bulk** keeps a running quantity; **Untracked** ' +
              'is presence-only — catalogued and locatable but with no quantity, and left out of ' +
              'low-stock, checkout, cycle counts and bookings.\n\nSwitching between these keeps the ' +
              'on-hand quantity (Untracked just hides it), so it’s reversible. **Serialised** and ' +
              '**Consumable** can’t be set after creation.'
            }
          >
            <Select
              value={trackingMode}
              onChange={(e) => setTrackingMode(e.target.value as TrackingMode)}
              data-testid="item-details-tracking"
            >
              {CONVERTIBLE_TRACKING_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {TRACKING_MODE_LABELS[mode]}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <FormField
            label="Tracking"
            hint={
              'How this item’s stock is counted, fixed at creation. **Serialised** and ' +
              '**Consumable (gauge)** items can’t be converted in place — create a new item if you ' +
              'need a different tracking mode.'
            }
          >
            <Input
              value={TRACKING_MODE_LABELS[item.trackingMode]}
              readOnly
              aria-readonly="true"
              className="cursor-not-allowed text-muted-foreground"
              data-testid="item-details-tracking"
            />
          </FormField>
        )}
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
