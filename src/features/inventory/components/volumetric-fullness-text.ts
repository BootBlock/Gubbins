import type { Formatters } from '@/lib/format';
import { isVolumetricFullness, type Fullness } from '../location-fullness';

/**
 * Plain-text description of a volumetric fullness reading (issue #457) for a `title`/`sr-only`
 * label — e.g. `12.5 L of 30 L · based on 2 of 3 items measured`. Returns null for count-mode
 * fullness (which the bar already conveys). The coverage clause is omitted when the location is
 * empty or fully measured, so the number is never qualified where it doesn't need to be.
 *
 * Kept in its own (non-component) module so the caption component's file exports only a component
 * (fast-refresh) while both it and `LocationInfoCard` share this one text builder.
 */
export function describeVolumetricFullness(fullness: Fullness, fmt: Formatters): string | null {
  if (!isVolumetricFullness(fullness)) return null;
  // Capacity anchors the reading in its own readable unit. The used volume shows in the *same*
  // unit while that keeps it legible, but a genuinely tiny amount would round to "0 L" there and
  // read as empty — so a small non-zero used value falls back to its own auto unit ("4 cm³ of
  // 30 L") rather than lying with "0 L of 30 L". An empty location (used 0) stays in the capacity
  // unit ("0 L of 30 L"), which is honest.
  const capUnit = fmt.volumeUnitFor(fullness.capacityVolume);
  const usedInCapUnit = fmt.volume(fullness.usedVolume, capUnit);
  const usedRoundsToZero = fullness.usedVolume > 0 && usedInCapUnit === fmt.volume(0, capUnit);
  const usedText = usedRoundsToZero ? fmt.volume(fullness.usedVolume) : usedInCapUnit;
  const used = `${usedText} of ${fmt.volume(fullness.capacityVolume, capUnit)}`;
  if (fullness.totalItems > 0 && fullness.coverage < 1) {
    return `${used} · based on ${fullness.measuredItems} of ${fullness.totalItems} items measured`;
  }
  return used;
}
