import { useEffect, useState } from 'react';
import { AutocompleteField, Button, FormField, Input, LiveRegion } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { clampNetValue } from '@/db/repositories/gauge';
import { useFormatters } from '@/lib/useFormatters';
import { GAUGE_CAPACITY_HINT, GAUGE_TARE_EDIT_HINT, GAUGE_UNIT_HINT } from '../gauge-field-copy';
import { useFieldSuggestions } from '../queries';
import { useReconfigureGauge } from '../mutations';

/**
 * Consumable-Gauge **configuration** editor (issue #69) — the unit of measure, full
 * capacity and tare a gauge was set up with.
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
  const reconfigure = useReconfigureGauge();
  const fmt = useFormatters();
  const { data: unitSuggestions } = useFieldSuggestions('unitOfMeasure');

  const gauge = item.gauge;
  // The mapper rebuilds `item.gauge` on every read, so the effect below keys off these
  // primitives rather than the object — otherwise a background refetch would identity-change
  // the gauge and wipe whatever the user had half-typed.
  const savedUnit = gauge?.unitOfMeasure ?? '';
  const savedCapacity = gauge ? String(gauge.grossCapacity) : '';
  const savedTare = gauge ? String(gauge.tareWeight) : '';

  const [unit, setUnit] = useState(savedUnit);
  const [capacity, setCapacity] = useState(savedCapacity);
  const [tare, setTare] = useState(savedTare);

  // Re-seed the draft whenever the persisted configuration changes (reopen, save, sync).
  useEffect(() => {
    setUnit(savedUnit);
    setCapacity(savedCapacity);
    setTare(savedTare);
  }, [savedUnit, savedCapacity, savedTare]);

  if (!gauge) {
    return (
      <p className="text-xs text-muted-foreground">
        Only consumable items measured on a gauge have a unit, capacity and tare to configure.
      </p>
    );
  }

  const trimmedUnit = unit.trim();
  const capacityValue = Number(capacity.trim());
  const tareValue = Number(tare.trim());

  const unitValid = trimmedUnit.length > 0;
  const capacityValid = capacity.trim() !== '' && Number.isFinite(capacityValue) && capacityValue > 0;
  const tareValid = tare.trim() !== '' && Number.isFinite(tareValue) && tareValue >= 0;
  const valid = unitValid && capacityValid && tareValid;

  const dirty =
    trimmedUnit !== gauge.unitOfMeasure ||
    (capacityValid && capacityValue !== gauge.grossCapacity) ||
    (tareValid && tareValue !== gauge.tareWeight);

  // How much material a smaller capacity would displace — surfaced before the save, not after.
  const spill = capacityValid
    ? gauge.currentNetValue - clampNetValue(gauge.currentNetValue, capacityValue)
    : 0;

  const save = () => {
    if (!valid || !dirty) return;
    reconfigure.mutate({
      id: item.id,
      change: { unitOfMeasure: trimmedUnit, grossCapacity: capacityValue, tareWeight: tareValue },
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
