import { useEffect, useState } from 'react';
import {
  AutocompleteField,
  Button,
  FormField,
  Input,
  LiveRegion,
  useReportUnsavedChanges,
} from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { ATTRITION_PERCENT_BOUNDS, clampNetValue, isValidAttritionPercent } from '@/db/repositories/gauge';
import { useFormatters } from '@/lib/useFormatters';
import { toGrams } from '@/lib/weight';
import {
  GAUGE_ATTRITION_HINT,
  GAUGE_CAPACITY_HINT,
  GAUGE_TARE_EDIT_HINT,
  GAUGE_UNIT_HINT,
} from '../gauge-field-copy';
import { gaugeTareWeightUnit, tareFieldValue } from '../tare-presets';
import { TarePresetPickerButton } from './TarePresetPickerButton';
import { useFieldSuggestions } from '../queries';
import { useReconfigureGauge } from '../mutations';

/**
 * Consumable-Gauge **configuration** editor (issue #69) — the unit of measure, full
 * capacity, tare and attrition rate a gauge was set up with.
 *
 * These are set in the Add-item dialog and were previously fixed for the life of the
 * item, so a mistyped unit (`g` where `m` was meant) or a spool swapped for a
 * differently-sized one left no way forward but deleting the item and recreating it,
 * discarding its Activity Log. This is the *what the gauge is* editor; how much is
 * currently in it stays with the Update dialog's consume / weigh-in / refill modes.
 *
 * Shrinking the capacity below the material presently in the gauge has to spill the
 * excess (§4.1.1 forbids a net value above capacity), so that consequence is spelled out
 * before saving rather than silently applied.
 */
export function GaugeConfigEditor({ item }: { item: Item }) {
  // "Is there a gauge to configure at all?" is answered here rather than inside the editor, so
  // the editor's hooks — including its unsaved-work report (#576) — are never sat behind an
  // early return. There is no draft to hold when there is nothing to configure.
  if (!item.gauge) {
    return (
      <p className="text-xs text-muted-foreground">
        Only consumable items measured on a gauge have a unit, capacity and tare to configure.
      </p>
    );
  }
  return <GaugeConfigForm item={item} gauge={item.gauge} />;
}

/** The editor proper, reached only for an item that actually carries gauge state. */
function GaugeConfigForm({ item, gauge }: { item: Item; gauge: NonNullable<Item['gauge']> }) {
  const reconfigure = useReconfigureGauge();
  const fmt = useFormatters();
  const { data: unitSuggestions } = useFieldSuggestions('unitOfMeasure');

  // The mapper rebuilds `item.gauge` on every read, so the effect below keys off these
  // primitives rather than the object — otherwise a background refetch would identity-change
  // the gauge and wipe whatever the user had half-typed.
  const savedUnit = gauge.unitOfMeasure;
  const savedCapacity = String(gauge.grossCapacity);
  const savedTare = String(gauge.tareWeight);
  // Blank is the honest rendering of "no attrition": a literal 0 in the box invites the
  // reading that a rate is set and happens to be zero.
  const savedAttrition = gauge.attritionPercent != null ? String(gauge.attritionPercent) : '';
  // Normalise absent → null so the dirty check below compares like with like; an unset rate
  // must not read as an edit the moment the editor mounts.
  const savedAttritionValue = gauge.attritionPercent ?? null;

  const [unit, setUnit] = useState(savedUnit);
  const [capacity, setCapacity] = useState(savedCapacity);
  const [tare, setTare] = useState(savedTare);
  const [attrition, setAttrition] = useState(savedAttrition);

  // Re-seed the draft whenever the persisted configuration changes (reopen, save, sync).
  useEffect(() => {
    setUnit(savedUnit);
    setCapacity(savedCapacity);
    setTare(savedTare);
    setAttrition(savedAttrition);
  }, [savedUnit, savedCapacity, savedTare, savedAttrition]);

  const trimmedUnit = unit.trim();
  const capacityValue = Number(capacity.trim());
  const tareValue = Number(tare.trim());

  // Attrition is optional: blank means "none" and resolves to null, which is what clears a
  // previously-set rate (issue #89).
  const trimmedAttrition = attrition.trim();
  const attritionValue = trimmedAttrition === '' ? null : Number(trimmedAttrition);
  const attritionValid = attritionValue === null || isValidAttritionPercent(attritionValue);

  const unitValid = trimmedUnit.length > 0;
  const capacityValid = capacity.trim() !== '' && Number.isFinite(capacityValue) && capacityValue > 0;
  const tareValid = tare.trim() !== '' && Number.isFinite(tareValue) && tareValue >= 0;
  // Keyed off the *draft* unit, so switching the gauge to grams offers the picker immediately
  // rather than only after the reconfiguration is saved.
  const tareWeightUnit = gaugeTareWeightUnit(trimmedUnit);
  const valid = unitValid && capacityValid && tareValid && attritionValid;

  const dirty =
    trimmedUnit !== gauge.unitOfMeasure ||
    (capacityValid && capacityValue !== gauge.grossCapacity) ||
    (tareValid && tareValue !== gauge.tareWeight) ||
    (attritionValid && attritionValue !== savedAttritionValue);
  // Let the dialog frame ask before discarding the draft on a dismissal (issue #576).
  useReportUnsavedChanges(dirty);

  // How much material a smaller capacity would displace — surfaced before the save, not after.
  const spill = capacityValid
    ? gauge.currentNetValue - clampNetValue(gauge.currentNetValue, capacityValue)
    : 0;

  const save = () => {
    if (!valid || !dirty) return;
    reconfigure.mutate({
      id: item.id,
      change: {
        unitOfMeasure: trimmedUnit,
        grossCapacity: capacityValue,
        tareWeight: tareValue,
        attritionPercent: attritionValue,
      },
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <AutocompleteField
          label="Unit"
          error={unitValid ? undefined : 'A unit is required.'}
          hint={GAUGE_UNIT_HINT}
          value={unit}
          onChange={setUnit}
          suggestions={unitSuggestions ?? []}
          placeholder="g, ml, m…"
        />
        <FormField
          label="Full capacity"
          error={capacityValid ? undefined : 'Capacity must be greater than zero.'}
          hint={GAUGE_CAPACITY_HINT}
        >
          <Input
            type="number"
            min={0}
            step="any"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            data-testid="gauge-config-capacity"
          />
        </FormField>
        {/* The picker is a *sibling* of the FormField, never a child: FormField clones its
            single control child to inject the error ARIA, so a second child would silently
            drop that wiring — and a button inside the <label> would fold into the control's
            accessible name and steal its clicks. */}
        <div>
          <FormField
            label="Tare (empty)"
            error={tareValid ? undefined : 'Tare must be zero or more.'}
            hint={GAUGE_TARE_EDIT_HINT}
          >
            <Input
              type="number"
              min={0}
              step="any"
              value={tare}
              onChange={(e) => setTare(e.target.value)}
              data-testid="gauge-config-tare"
            />
          </FormField>
          {/* Only offered when the gauge is actually measured by mass: the tare is carried in
              the gauge's own unit, so a gram figure written into a gauge measured in metres
              would be a meaningless number that merely looks plausible (issue #94). */}
          {tareWeightUnit ? (
            <div className="mt-field-gap-compact">
              <TarePresetPickerButton
                currentTareGrams={tareValid ? toGrams(tareValue, tareWeightUnit) : null}
                onSelect={(grams) => setTare(tareFieldValue(grams, tareWeightUnit))}
                data-testid="gauge-config-tare-preset"
              />
            </div>
          ) : null}
        </div>
        <FormField
          label="Attrition (optional)"
          error={
            attritionValid
              ? undefined
              : `Attrition must be between ${ATTRITION_PERCENT_BOUNDS.min} and ${ATTRITION_PERCENT_BOUNDS.max}%.`
          }
          hint={GAUGE_ATTRITION_HINT}
        >
          <Input
            type="number"
            min={ATTRITION_PERCENT_BOUNDS.min}
            max={ATTRITION_PERCENT_BOUNDS.max}
            step="any"
            value={attrition}
            onChange={(e) => setAttrition(e.target.value)}
            placeholder="None"
            data-testid="gauge-config-attrition"
          />
        </FormField>
      </div>

      {/* Always-mounted region: a `role="status"` element inserted at the moment its message
          appears often goes unannounced, and this warning precedes an irreversible save, so a
          screen-reader user must hear it. Both amounts are labelled in the gauge's *saved*
          unit — nothing has been relabelled yet, so quoting a half-typed new unit here would
          contradict the level it sits beside. */}
      <LiveRegion className="empty:hidden">
        {spill > 0 ? (
          <p className="text-xs font-medium text-warning" data-testid="gauge-config-spill">
            This capacity is below the {fmt.measure(gauge.currentNetValue, gauge.unitOfMeasure)} currently in
            the gauge — {fmt.measure(spill, gauge.unitOfMeasure)} will be discarded and recorded in the item’s
            history.
          </p>
        ) : null}
      </LiveRegion>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || !valid || reconfigure.isPending}
          data-testid="gauge-config-save"
        >
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
