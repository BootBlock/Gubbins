import { useEffect, useState } from 'react';
import {
  AutocompleteField,
  Button,
  Checkbox,
  FormField,
  InfoHint,
  Input,
  MoneyInput,
  SelectField,
  Textarea,
  useReportUnsavedChanges,
} from '@/components/foundry';
import { CONVERTIBLE_TRACKING_MODES, type Item, type TrackingMode } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { fromGrams, toGrams, type WeightUnit } from '@/lib/weight';
import { BarcodeScanDialog } from '@/features/scanner/components/BarcodeScanDialog';
import { useT } from '@/features/i18n';
import { BarcodeField } from './BarcodeField';
import { dimensionToInput, resolveDimension } from '../measure-input';
import { parseOptionalNumber, resolveMeasureDraft, type MeasureIssue } from './measure-draft';
import { useCategories } from '../categories';
import { gaugeCostHint } from '../gauge-field-copy';
import { ITEM_NAME_EDIT_HINT } from '../item-field-copy';
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
  const t = useT();
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
  const [serialNumber, setSerialNumber] = useState(item.serialNumber ?? '');
  const [unitCost, setUnitCost] = useState(item.unitCost?.toString() ?? '');
  // Gauge-only (issue #683): what one unit of *measure* of the contents costs, which is the
  // only figure a gauge's stock can be valued from — its unit count is always 0.
  const [costPerUnitOfMeasure, setCostPerUnitOfMeasure] = useState(
    item.gauge?.costPerUnitOfMeasure?.toString() ?? '',
  );
  const [categoryId, setCategoryId] = useState(item.categoryId ?? '');
  const [isUnlimited, setIsUnlimited] = useState(item.isUnlimited);
  // Weight is entered/shown in the user's chosen unit; the stored value is canonical grams.
  const [weight, setWeight] = useState(() => weightToInput(item.weight, weightUnit));
  // Dimensions are entered/shown in the user's chosen unit; stored values are canonical mm.
  const [width, setWidth] = useState(() => dimensionToInput(item.width, dimensionUnit));
  const [height, setHeight] = useState(() => dimensionToInput(item.height, dimensionUnit));
  const [depth, setDepth] = useState(() => dimensionToInput(item.depth, dimensionUnit));
  // Camera barcode capture for the Barcode field (issue #8/#52): {@link BarcodeField} owns the
  // "Scan" button and its `scanner`-capability gating; this only holds the dialog it opens,
  // which stacks on top of the editor.
  const [barcodeScanOpen, setBarcodeScanOpen] = useState(false);

  // Re-sync the whole draft when the persisted item changes (open, after a save, or a sync
  // landing).
  //
  // Keyed on the persisted *values*, never on `item` identity — the same discipline
  // `GaugeConfigEditor` follows, and for the same reason twice over. An optimistic mutation
  // rebuilds the cached item (`{ ...item, ...changes }`), as does a background refetch, so an
  // identity-keyed effect re-seeds on a write that touched none of these fields: saving the
  // low-stock point on another tab would wipe a half-typed Name here, now that the panel stays
  // mounted behind you. Listing the fields keeps the re-seed to writes that actually changed one.
  //
  // The unit preferences stay out of the deps for the separate #158 reason: switching grams→ounces
  // must not reach the text fields. The measurements are re-expressed by the effects below.
  useEffect(() => {
    setName(item.name);
    setTrackingMode(item.trackingMode);
    setDescription(item.description ?? '');
    setNotes(item.notes ?? '');
    setMpn(item.mpn ?? '');
    setManufacturer(item.manufacturer ?? '');
    setBarcode(item.barcode ?? '');
    setSerialNumber(item.serialNumber ?? '');
    setUnitCost(item.unitCost?.toString() ?? '');
    setCostPerUnitOfMeasure(item.gauge?.costPerUnitOfMeasure?.toString() ?? '');
    setCategoryId(item.categoryId ?? '');
    setIsUnlimited(item.isUnlimited);
    setWeight(weightToInput(item.weight, weightUnit));
    setWidth(dimensionToInput(item.width, dimensionUnit));
    setHeight(dimensionToInput(item.height, dimensionUnit));
    setDepth(dimensionToInput(item.depth, dimensionUnit));
    // `weightUnit`/`dimensionUnit` are read for the initial re-expression but deliberately kept
    // out of the deps — a unit change is handled by the dedicated effects below, not here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    item.name,
    item.trackingMode,
    item.description,
    item.notes,
    item.mpn,
    item.manufacturer,
    item.barcode,
    item.serialNumber,
    item.unitCost,
    item.gauge?.costPerUnitOfMeasure,
    item.categoryId,
    item.isUnlimited,
    item.weight,
    item.width,
    item.height,
    item.depth,
  ]);

  // Re-express the stored canonical weight when only the weight *unit* preference changes, so the
  // displayed number tracks grams→ounces without touching any other field (issue #158).
  useEffect(() => {
    setWeight(weightToInput(item.weight, weightUnit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weightUnit]);

  // Likewise re-express the stored canonical dimensions when only the dimension *unit* preference
  // changes, leaving the text fields (and weight) untouched (issue #158).
  useEffect(() => {
    setWidth(dimensionToInput(item.width, dimensionUnit));
    setHeight(dimensionToInput(item.height, dimensionUnit));
    setDepth(dimensionToInput(item.depth, dimensionUnit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensionUnit]);

  // "Unlimited supply" is a DISCRETE-only modifier (Phase 82).
  const canBeUnlimited = item.trackingMode === 'DISCRETE';

  const text = (raw: string): string | null => (raw.trim().length > 0 ? raw.trim() : null);
  // A price is optional but, when entered, must be a usable non-negative number — the same
  // rule the measurements below follow, so two adjacent numeric fields behave alike.
  const unitCostEntry = parseOptionalNumber(unitCost);
  const costPerUomEntry = parseOptionalNumber(costPerUnitOfMeasure);
  // The column is CONSUMABLE_GAUGE-only (the repository rejects it for any other mode), so the
  // field is only offered — and only enters the draft — when the item actually is one.
  const isGauge = item.trackingMode === 'CONSUMABLE_GAUGE';
  // The gauge's own unit names the cost field ("Cost per g"), so the label says what is being
  // priced rather than leaving the reader to infer it. A gauge always has one; the fallback is
  // only for a malformed row that reached the editor without gauge state.
  const gaugeUnitLabel = item.gauge?.unitOfMeasure ?? 'unit';
  // Weight resolves its dirty flag + canonical-gram value in one go; each dimension does the
  // same against millimetres. An untouched field keeps its stored value, so re-saving another
  // field never nudges it by the conversion's floating-point error (e.g. 1600 g via ounces).
  const weightState = resolveMeasureDraft(
    weight,
    item.weight,
    (entered) => toGrams(entered, weightUnit),
    (grams) => weightToInput(grams, weightUnit),
  );
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
    serialNumber: text(serialNumber),
    unitCost: unitCostEntry.issue === null ? unitCostEntry.value : (item.unitCost ?? null),
    ...(isGauge
      ? {
          costPerUnitOfMeasure:
            costPerUomEntry.issue === null
              ? costPerUomEntry.value
              : (item.gauge?.costPerUnitOfMeasure ?? null),
        }
      : {}),
    weight: weightState.value,
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
    draft.serialNumber !== (item.serialNumber ?? null) ||
    draft.unitCost !== (item.unitCost ?? null) ||
    unitCostEntry.issue !== null ||
    (isGauge &&
      (costPerUomEntry.value !== (item.gauge?.costPerUnitOfMeasure ?? null) ||
        costPerUomEntry.issue !== null)) ||
    weightState.dirty ||
    widthState.dirty ||
    heightState.dirty ||
    depthState.dirty ||
    draft.categoryId !== (item.categoryId ?? null) ||
    draft.isUnlimited !== item.isUnlimited;
  // Tell the dialog frame the draft is uncommitted, so Escape, a backdrop tap or Close asks
  // before taking it away rather than discarding it silently (issue #576).
  useReportUnsavedChanges(dirty);
  // A bad number blocks the save and shows why, rather than quietly clearing the stored
  // value — the failure branch of a "valid ? convert : null" guard reads as "clear this
  // field", which is not what typing `-5` over a stored weight means (issue #345).
  const measureIssue = (issue: MeasureIssue | null): string | undefined =>
    issue === null
      ? undefined
      : issue === 'negative'
        ? t('inventory.details.negative')
        : t('inventory.details.notANumber');
  const valid =
    draft.name.length > 0 &&
    unitCostEntry.issue === null &&
    (!isGauge || costPerUomEntry.issue === null) &&
    weightState.issue === null &&
    widthState.issue === null &&
    heightState.issue === null &&
    depthState.issue === null;

  const save = () => update.mutate({ id: item.id, input: draft });

  return (
    <div className="space-y-3">
      <FormField
        label="Name"
        error={draft.name.length > 0 ? undefined : 'Please enter a name.'}
        hintSize="md"
        hint={ITEM_NAME_EDIT_HINT}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="item-details-name" />
      </FormField>

      <FormField
        label="Description (optional)"
        hint="What the item **is** — factual, display-worthy copy (e.g. a one-line datasheet summary). Searchable."
      >
        <Textarea
          sizeKey="item.description"
          autoGrow
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
          sizeKey="item.notes"
          autoGrow
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

      <BarcodeField
        value={barcode}
        onChange={setBarcode}
        onScan={() => setBarcodeScanOpen(true)}
        inputTestId="item-details-barcode"
        scanTestId="item-details-barcode-scan"
      />

      <FormField
        label="Serial number (optional)"
        hint={
          'The **serial number** printed on this unit — the maker’s unique per-unit identifier ' +
          '(e.g. an equipment or tool serial).\n\nDistinct from the **MPN** (which is the same for ' +
          'every unit of a part) and from the **Barcode** (the retail GTIN). Searchable.'
        }
      >
        <Input
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
          placeholder="e.g. SN-2024-0042"
          data-testid="item-details-serial-number"
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="Unit cost (optional)"
          error={measureIssue(unitCostEntry.issue)}
          hint={
            'What **one unit** costs, in your base currency. Drives valuation and project ' +
            'costing.\n\nWhen set, this **manual** cost overrides the preferred supplier’s price; ' +
            'leave it blank to use the preferred supplier from the **Supplier & ops** tab.' +
            // A gauge holds a measure rather than units, so this cost values nothing on it —
            // saying so beats leaving the claim above standing (issue #683).
            (isGauge
              ? `\n\n> A gauge is **not** valued from this. Use *Cost per ${gaugeUnitLabel}* beside it.`
              : '')
          }
        >
          <MoneyInput value={unitCost} onValueChange={setUnitCost} placeholder="0.00" />
        </FormField>
        {isGauge ? (
          <FormField
            label={`Cost per ${gaugeUnitLabel} (optional)`}
            error={measureIssue(costPerUomEntry.issue)}
            hint={gaugeCostHint(gaugeUnitLabel)}
          >
            <MoneyInput
              value={costPerUnitOfMeasure}
              onValueChange={setCostPerUnitOfMeasure}
              placeholder="0.00"
              data-testid="item-details-cost-per-uom"
            />
          </FormField>
        ) : null}
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
          error={measureIssue(weightState.issue)}
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
          error={measureIssue(widthState.issue)}
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
          error={measureIssue(heightState.issue)}
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
          error={measureIssue(depthState.issue)}
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
        <Checkbox
          checked={draft.isUnlimited}
          disabled={!canBeUnlimited}
          onChange={(e) => setIsUnlimited(e.target.checked)}
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
