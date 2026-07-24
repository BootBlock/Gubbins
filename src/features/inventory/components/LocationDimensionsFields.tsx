import { FormField, InfoHint, Input } from '@/components/foundry';
import { useFormatters } from '@/lib/useFormatters';
import type { DimensionUnit } from '@/lib/dimensions';
import type { MeasureDraft } from './measure-draft';
import { HINT_DIMENSIONS } from './location-field-help';

/**
 * The internal-size field group shared by the Add- and Edit-location dialogs (issue #457):
 * width × height × depth, each entered in the user's `dimensionUnit` and stored canonically in
 * millimetres, with a live derived-volume preview ("≈ 12.5 L") beneath. Presentational — the
 * owning dialog computes each field's {@link MeasureDraft} (via the shared `resolveDimension`
 * helper) and the derived volume (via `volumeFromDimensions`), so the parsed values and validity
 * live in one place for the save path while the markup stays in one place for both dialogs.
 *
 * The volume preview is rendered through the reactive `volume` formatter, so it honours the
 * user's `volumeUnit` preference (Automatic by default). Only a single `i` hint is shown — on
 * the first field — because one explanation covers all three axes; a badge per field would be
 * noise.
 */
export function LocationDimensionsFields({
  dimensionUnit,
  width,
  height,
  depth,
  onWidthChange,
  onHeightChange,
  onDepthChange,
  states,
  derivedVolume,
}: {
  dimensionUnit: DimensionUnit;
  width: string;
  height: string;
  depth: string;
  onWidthChange: (value: string) => void;
  onHeightChange: (value: string) => void;
  onDepthChange: (value: string) => void;
  states: { width: MeasureDraft; height: MeasureDraft; depth: MeasureDraft };
  /** Bounding-box volume in canonical mm³, or null until all three dimensions parse. */
  derivedVolume: number | null;
}) {
  const fmt = useFormatters();
  // A bad entry blocks the save and says why, rather than silently clearing the stored value —
  // the same clear-vs-error discipline the item editor's measurements use (issue #345).
  const issueText = (state: MeasureDraft): string | undefined =>
    state.issue === null ? undefined : state.issue === 'negative' ? 'Must be 0 or more.' : 'Enter a number.';
  // While any field is invalid its draft keeps the *stored* value (so nothing is erased), which
  // would otherwise let the preview show a volume that doesn't match what's on screen. Suppress
  // it until all three parse, so the number never contradicts a visible error.
  const hasIssue = states.width.issue !== null || states.height.issue !== null || states.depth.issue !== null;
  const showVolume = derivedVolume != null && !hasIssue;

  return (
    <div>
      {/* The single hint sits *outside* any FormField `<label>`, on its own header row, so it
          never folds into a control's accessible name (the pattern the other location fields use). */}
      <div className="relative">
        <span className="mb-field-gap block pr-6 text-sm font-medium">Dimensions (optional)</span>
        <span className="absolute right-0 top-0.5">
          <InfoHint content={HINT_DIMENSIONS} />
        </span>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label={`Width (${dimensionUnit})`} error={issueText(states.width)}>
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={width}
              onChange={(e) => onWidthChange(e.target.value)}
              placeholder="—"
              aria-label={`Internal width in ${dimensionUnit}`}
              data-testid="location-width"
            />
          </FormField>
          <FormField label={`Height (${dimensionUnit})`} error={issueText(states.height)}>
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={height}
              onChange={(e) => onHeightChange(e.target.value)}
              placeholder="—"
              aria-label={`Internal height in ${dimensionUnit}`}
              data-testid="location-height"
            />
          </FormField>
          <FormField label={`Depth (${dimensionUnit})`} error={issueText(states.depth)}>
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={depth}
              onChange={(e) => onDepthChange(e.target.value)}
              placeholder="—"
              aria-label={`Internal depth in ${dimensionUnit}`}
              data-testid="location-depth"
            />
          </FormField>
        </div>
      </div>
      {/* Live derived volume — appears once all three dimensions are present and valid. `aria-live`
          announces it to a screen-reader user as they finish entering the third measurement. */}
      {showVolume ? (
        <p
          className="mt-field-gap-compact text-xs text-muted-foreground"
          aria-live="polite"
          data-testid="location-volume-preview"
        >
          Volume ≈{' '}
          <span className="font-medium text-foreground tabular-nums">{fmt.volume(derivedVolume)}</span>
        </p>
      ) : null}
    </div>
  );
}
