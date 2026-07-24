import { useId, useState } from 'react';
import { FormField, Input } from '@/components/foundry';
import { ChevronRightIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { volumeUnitLabel, type VolumeUnit } from '@/lib/volume';
import { PACKING_PERCENT_MAX, PACKING_PERCENT_MIN } from '../measure-input';
import type { MeasureDraft } from './measure-draft';

/**
 * The **Advanced** disclosure in the location dialogs (issue #457, Phase 2): the two optional
 * overrides that refine cube utilisation beyond the plain W×H×D box — an explicit **usable
 * volume** (for an irregular container) and a per-location **packing efficiency** (the fraction
 * realistically fillable). Kept behind a collapsed disclosure so the common case stays the three
 * dimension fields; the overrides only matter to users who want to tune the honesty of the gauge.
 *
 * Presentational and controlled: the owning dialog holds the raw strings + parsed states (via the
 * shared `resolveVolume` helper and a percentage parse), so the save path and validity live in
 * one place, mirroring {@link LocationDimensionsFields}.
 */
export function LocationAdvancedVolumeFields({
  volumeUnit,
  usableVolume,
  onUsableVolumeChange,
  usableVolumeState,
  packingPercent,
  onPackingPercentChange,
  packingOutOfRange,
  defaultPackingPercent,
}: {
  /** The concrete unit the usable-volume field is entered in (label + conversion). */
  volumeUnit: VolumeUnit;
  usableVolume: string;
  onUsableVolumeChange: (value: string) => void;
  usableVolumeState: MeasureDraft;
  packingPercent: string;
  onPackingPercentChange: (value: string) => void;
  /** Whether the packing entry is outside the valid percentage range. */
  packingOutOfRange: boolean;
  /** The global default packing efficiency (%), shown as the field's placeholder. */
  defaultPackingPercent: number;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const t = useT();

  const packingError = packingOutOfRange
    ? t('inventory.location.measure.packingRange', {
        // Strings so the bounds render verbatim, never a locale-grouped number.
        vars: { min: String(PACKING_PERCENT_MIN), max: String(PACKING_PERCENT_MAX) },
      })
    : undefined;

  const usableIssue =
    usableVolumeState.issue === null
      ? undefined
      : usableVolumeState.issue === 'negative'
        ? t('inventory.location.measure.errorNegative')
        : t('inventory.location.measure.errorNaN');

  // Keep the section expanded whenever a field has a blocking error — its error text lives inside
  // the disclosure, so collapsing it while invalid would leave the disabled Save/Create button
  // with no on-screen reason (the parent folds these issues into its submit guard).
  const hasError = usableIssue !== undefined || packingError !== undefined;
  const expanded = open || hasError;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        aria-controls={regionId}
        className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        data-testid="location-advanced-toggle"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn('size-4 transition-transform', expanded && 'rotate-90')}
        />
        {t('inventory.location.advanced.toggle')}
      </button>

      {expanded ? (
        <div id={regionId} className="mt-field-gap grid gap-3 sm:grid-cols-2">
          <FormField
            label={t('inventory.location.advanced.usableVolume', {
              vars: { unit: volumeUnitLabel(volumeUnit) },
            })}
            error={usableIssue}
            hint={t('inventory.location.hint.usableVolume')}
          >
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={usableVolume}
              onChange={(e) => onUsableVolumeChange(e.target.value)}
              placeholder={t('inventory.location.advanced.usableVolumePlaceholder')}
              data-testid="location-usable-volume"
            />
          </FormField>
          <FormField
            label={t('inventory.location.advanced.packing')}
            error={packingError}
            hint={t('inventory.location.hint.packingFactor')}
          >
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={PACKING_PERCENT_MIN}
                max={PACKING_PERCENT_MAX}
                step="any"
                inputMode="decimal"
                value={packingPercent}
                onChange={(e) => onPackingPercentChange(e.target.value)}
                placeholder={String(defaultPackingPercent)}
                data-testid="location-packing-factor"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </FormField>
        </div>
      ) : null}
    </div>
  );
}
