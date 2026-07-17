import { useEffect, useState } from 'react';
import {
  AutocompleteField,
  Button,
  FormField,
  InfoHint,
  Input,
  MoneyInput,
  SelectField,
  Textarea,
} from '@/components/foundry';
import { ScanIcon } from '@/components/icons';
import { CONVERTIBLE_TRACKING_MODES, type Item, type TrackingMode } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { fromGrams, toGrams, type WeightUnit } from '@/lib/weight';
import { fromMm, toMm, type DimensionUnit } from '@/lib/dimensions';
import { BarcodeScanDialog } from '@/features/scanner/components/BarcodeScanDialog';
import { useFeature } from '@/features/modules/useFeature';
import { useCategories } from '../categories';
import { useUpdateItem } from '../mutations';
import { useFieldSuggestions } from '../queries';
import { TRACKING_MODE_LABELS } from './inventory-ui';

/** Whether this item's tracking mode is one that can be switched in place (Bulk ↔ Untracked). */
const isTrackingEditable = (mode: TrackingMode): boolean =>
  (CONVERTIBLE_TRACKING_MODES as readonly TrackingMode[]).includes(mode);

/**
 * Render a stored canonical-gram weight as an input string in `unit` (blank when unset),
 * with floating-point noise from the conversion trimmed off (so `1250 g` shows as `1.25`
 * in kg, not `1.2500000001`).
 */
function weightToInput(grams: number | null, unit: WeightUnit): string {
  if (grams == null) return '';
  return String(Number(fromGrams(grams, unit).toFixed(6)));
}

/**
 * Render a stored canonical-millimetre dimension as an input string in `unit` (blank when
 * unset), with conversion floating-point noise trimmed — the dimension counterpart to
 * {@link weightToInput}.
 */
function dimensionToInput(mm: number | null, unit: DimensionUnit): string {
  if (mm == null) return '';
  return String(Number(fromMm(mm, unit).toFixed(6)));
}

/**
 * Derive one dimension field's draft state from its input string and stored value. `dirty`
 * compares the input against the canonical display of the stored value so the mm↔unit
 * conversion's floating-point noise never marks an untouched field dirty; `value` keeps the
 * exact stored mm when untouched (so saving a *different* field never nudges it via the
 * round-trip) and otherwise re-derives canonical mm from the entry (blank/invalid → null).
 */
function resolveDimension(
  input: string,
  stored: number | null,
  unit: DimensionUnit,
): { readonly dirty: boolean; readonly value: number | null } {
  const entered = input.trim() === '' ? null : Number(input);
  const next = entered !== null && Number.isFinite(entered) && entered >= 0 ? toMm(entered, unit) : null;
  const dirty = input.trim() !== dimensionToInput(stored, unit);
  return { dirty, value: dirty ? next : (stored ?? null) };
}

/** Rich help for the "Unlimited supply" modifier (Phase 82). */
const HINT_UNLIMITED =
  'Marks this as an **effectively infinite source** — tap water, mains air, a bulk pile you ' +
  'never count.\n\nIts quantity shows as **∞**, it **never** runs low or joins the shopping ' +
  'list, it is **excluded** from stock valuation and cycle counts, and using it in a build ' +
  'never causes a shortage. Only available for **bulk (DISCRETE)** items.';

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
  const { data: manufacturerSuggestions } = useFieldSuggestions('manufacturer');
  const weightUnit = usePreferencesStore((s) => s.weightUnit);
  const dimensionUnit = usePreferencesStore((s) => s.dimensionUnit);

  const [name, setName] = useState(item.name);
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(item.trackingMode);
  const [description, setDescription] = useState(item.description ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [mpn, setMpn] = useState(item.mpn ?? '');
  const [manufacturer, setManufacturer] = useState(item.manufacturer ?? '');
  const [barcode, setBarcode] = useState(item.barcode ?? '');
  const [unitCost, setUnitCost] = useState(item.unitCost?.toString() ?? '');
  const [categoryId, setCategoryId] = useState(item.categoryId ?? '');
  const [isUnlimited, setIsUnlimited] = useState(item.isUnlimited);
  // Weight is entered/shown in the user's chosen unit; the stored value is canonical grams.
  const [weight, setWeight] = useState(() => weightToInput(item.weight, weightUnit));
  // Dimensions are entered/shown in the user's chosen unit; stored values are canonical mm.
  const [width, setWidth] = useState(() => dimensionToInput(item.width, dimensionUnit));
  const [height, setHeight] = useState(() => dimensionToInput(item.height, dimensionUnit));
  const [depth, setDepth] = useState(() => dimensionToInput(item.depth, dimensionUnit));
  // Camera barcode capture for the Barcode field (issue #8/#52): a "Scan" button beside the
  // field opens the shared scanner to fill the GTIN without typing. Gated by the same `scanner`
  // capability as the Add-item dialog — with it off the button is hidden; the field is still
  // typable. The dialog stacks on top of the editor.
  const [barcodeScanOpen, setBarcodeScanOpen] = useState(false);
  const scannerEnabled = useFeature('scanner');

  // Re-sync the draft when the persisted values change (open, after a save, or sync).
  useEffect(() => {
    setName(item.name);
    setTrackingMode(item.trackingMode);
    setDescription(item.description ?? '');
    setNotes(item.notes ?? '');
    setMpn(item.mpn ?? '');
    setManufacturer(item.manufacturer ?? '');
    setBarcode(item.barcode ?? '');
    setUnitCost(item.unitCost?.toString() ?? '');
    setCategoryId(item.categoryId ?? '');
    setIsUnlimited(item.isUnlimited);
    // Also re-syncs when the weight *unit* preference changes, re-expressing the stored grams.
    setWeight(weightToInput(item.weight, weightUnit));
    // Likewise re-express the stored mm when the item or the dimension *unit* preference changes.
    setWidth(dimensionToInput(item.width, dimensionUnit));
    setHeight(dimensionToInput(item.height, dimensionUnit));
    setDepth(dimensionToInput(item.depth, dimensionUnit));
  }, [item, weightUnit, dimensionUnit]);

  // "Unlimited supply" is a DISCRETE-only modifier (Phase 82).
  const canBeUnlimited = item.trackingMode === 'DISCRETE';

  const text = (raw: string): string | null => (raw.trim().length > 0 ? raw.trim() : null);
  const nextUnitCost = unitCost.trim() === '' ? null : Number(unitCost);
  // Convert the entered weight (in `weightUnit`) back to canonical grams; blank/invalid → null.
  const enteredWeight = weight.trim() === '' ? null : Number(weight);
  const nextWeight =
    enteredWeight !== null && Number.isFinite(enteredWeight) && enteredWeight >= 0
      ? toGrams(enteredWeight, weightUnit)
      : null;
  // Compare the input string against the canonical display of the stored value so the
  // grams↔unit conversion's floating-point noise never marks an untouched field dirty.
  const weightDirty = weight.trim() !== weightToInput(item.weight, weightUnit);
  // Each dimension resolves its own dirty flag + canonical-mm value (same untouched-value
  // discipline as weight, so re-saving another field never nudges a stored dimension).
  const widthState = resolveDimension(width, item.width, dimensionUnit);
  const heightState = resolveDimension(height, item.height, dimensionUnit);
  const depthState = resolveDimension(depth, item.depth, dimensionUnit);
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
    barcode: text(barcode),
    unitCost: Number.isFinite(nextUnitCost ?? 0) ? nextUnitCost : null,
    // Only re-derive grams from the input when the field was actually edited; an untouched
    // weight keeps its exact stored value, so saving a *different* field never nudges it by
    // the grams↔unit conversion's floating-point error (e.g. re-saving 1600 g via ounces).
    weight: weightDirty ? nextWeight : (item.weight ?? null),
    width: widthState.value,
    height: heightState.value,
    depth: depthState.value,
    categoryId: categoryId || null,
    // Only a DISCRETE item can carry the flag; ignore stale UI state for other modes.
    isUnlimited: canBeUnlimited ? isUnlimited : false,
  };
  const dirty =
    draft.name !== item.name ||
    (trackingEditable && trackingMode !== item.trackingMode) ||
    draft.description !== (item.description ?? null) ||
    draft.notes !== (item.notes ?? null) ||
    draft.mpn !== (item.mpn ?? null) ||
    draft.manufacturer !== (item.manufacturer ?? null) ||
    draft.barcode !== (item.barcode ?? null) ||
    draft.unitCost !== (item.unitCost ?? null) ||
    weightDirty ||
    widthState.dirty ||
    heightState.dirty ||
    depthState.dirty ||
    draft.categoryId !== (item.categoryId ?? null) ||
    draft.isUnlimited !== item.isUnlimited;
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
        <AutocompleteField
          label="Manufacturer (optional)"
          hint="Who makes the part (e.g. *Texas Instruments*). Type-ahead suggests makers already in your catalogue."
          value={manufacturer}
          onChange={setManufacturer}
          suggestions={manufacturerSuggestions ?? []}
          placeholder="e.g. Texas Instruments"
        />
      </div>

      {/* The Scan button sits beside the field (issue #52) but *outside* the FormField's
          `<label>` — so it never folds into the input's accessible name and clicking it can't
          be mistaken for the label. `items-end` bottom-aligns it with the input (both h-10).
          Mirrors the Add-item dialog's Barcode field exactly. */}
      <div className="flex items-end gap-2">
        <FormField
          className="flex-1"
          label="Barcode (optional)"
          hintSize="lg"
          hint={
            'The **retail barcode** (GTIN) printed on the packaging — EAN-13, UPC-A, EAN-8 or ' +
            'GTIN-14.\n\nScanning a product barcode fills this automatically. It is the item’s ' +
            'own scannable code, distinct from the **MPN** above.\n\n> A future scan of the same ' +
            'barcode jumps straight to this item.'
          }
        >
          <Input
            inputMode="numeric"
            placeholder="e.g. 4006381333931"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            data-testid="item-details-barcode"
          />
        </FormField>
        {scannerEnabled ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setBarcodeScanOpen(true)}
            data-testid="item-details-barcode-scan"
          >
            <ScanIcon aria-hidden />
            Scan
          </Button>
        ) : null}
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
          <MoneyInput value={unitCost} onValueChange={setUnitCost} placeholder="0.00" />
        </FormField>
        <SelectField
          label="Category"
          hint="Groups the item and unlocks that category’s **custom fields**. *None* leaves it uncategorised."
          value={categoryId}
          onChange={setCategoryId}
          options={[
            { value: '', label: '— None —' },
            ...(categories?.rows ?? []).map((cat) => ({ value: cat.id, label: cat.name })),
          ]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={`Weight (${weightUnit})`}
          hint={
            'The item’s **weight** for one unit, in your chosen weight unit (change the unit in ' +
            '**Settings**). Stored independently of the unit, so switching units just re-displays ' +
            'the same weight. Leave blank if you don’t track it.'
          }
        >
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="—"
            aria-label={`Weight in ${weightUnit}`}
            data-testid="item-details-weight"
          />
        </FormField>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          label={`Width (${dimensionUnit})`}
          hint={
            'The item’s **width** for one unit, in your chosen dimension unit (change the unit in ' +
            '**Settings**). Stored independently of the unit, so switching units just re-displays ' +
            'the same size. Leave blank if you don’t track it.'
          }
        >
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            placeholder="—"
            aria-label={`Width in ${dimensionUnit}`}
            data-testid="item-details-width"
          />
        </FormField>
        <FormField
          label={`Height (${dimensionUnit})`}
          hint={
            'The item’s **height** for one unit, in your chosen dimension unit (change the unit in ' +
            '**Settings**). Stored independently of the unit, so switching units just re-displays ' +
            'the same size. Leave blank if you don’t track it.'
          }
        >
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            placeholder="—"
            aria-label={`Height in ${dimensionUnit}`}
            data-testid="item-details-height"
          />
        </FormField>
        <FormField
          label={`Depth (${dimensionUnit})`}
          hint={
            'The item’s **depth** for one unit, in your chosen dimension unit (change the unit in ' +
            '**Settings**). Stored independently of the unit, so switching units just re-displays ' +
            'the same size. Leave blank if you don’t track it.'
          }
        >
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
            placeholder="—"
            aria-label={`Depth in ${dimensionUnit}`}
            data-testid="item-details-depth"
          />
        </FormField>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {trackingEditable ? (
          <SelectField
            label="Tracking"
            hint={
              'How this item’s stock is counted. **Bulk** keeps a running quantity; **Untracked** ' +
              'is presence-only — catalogued and locatable but with no quantity, and left out of ' +
              'low-stock, checkout, cycle counts and bookings.\n\nSwitching between these keeps the ' +
              'on-hand quantity (Untracked just hides it), so it’s reversible. **Serialised** and ' +
              '**Consumable** can’t be set after creation.'
            }
            options={CONVERTIBLE_TRACKING_MODES.map((mode) => ({
              value: mode,
              label: TRACKING_MODE_LABELS[mode],
            }))}
            value={trackingMode}
            onChange={(value) => setTrackingMode(value as TrackingMode)}
            data-testid="item-details-tracking"
          />
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

      <label
        className="flex cursor-pointer items-center gap-2 text-sm data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60"
        data-disabled={!canBeUnlimited}
      >
        <input
          type="checkbox"
          checked={draft.isUnlimited}
          disabled={!canBeUnlimited}
          onChange={(e) => setIsUnlimited(e.target.checked)}
          className="size-4 accent-primary"
          data-testid="item-details-unlimited"
        />
        Unlimited supply
        <InfoHint content={HINT_UNLIMITED} />
        {!canBeUnlimited ? <span className="text-xs text-muted-foreground">(bulk items only)</span> : null}
      </label>

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

      {/* Camera barcode capture (issue #52). The dialog renders through a portal, so its place
          in the tree here is immaterial (it returns null while closed); a decoded barcode fills
          the field directly — an explicit user action, so it overwrites. */}
      <BarcodeScanDialog
        open={barcodeScanOpen}
        onClose={() => setBarcodeScanOpen(false)}
        onCapture={setBarcode}
      />
    </div>
  );
}
