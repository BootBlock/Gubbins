/**
 * FoundHereField — the count sheet's "I found something that isn't listed" control (issue #640).
 *
 * Its own module rather than a function inside {@link CycleCountLines} because it is the one part
 * of the sheet that reads the item catalogue: it mounts {@link ItemPicker}, which brings the
 * inventory queries with it. Keeping that dependency behind a named seam lets the sheet's own
 * rendering tests — and the two dialogs' — stub a picker rather than stand up a catalogue, while
 * this module is exercised against the real one.
 */
import { useCallback, useState } from 'react';
import { LiveRegion } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { ItemPicker } from '@/features/inventory/components/ItemPicker';
import { foundLineKey, type FoundHereEntry } from '../cycle-count';
import type { LocationCycleCount } from '../useLocationCycleCount';

/**
 * "I found something the sheet does not list" — the control that lets a count record a
 * **presence** rather than only an absence (issue #640).
 *
 * Without it a stock-take could only ever destroy stock it could not find. Twelve units recorded
 * in one drawer and actually sitting in the next were counted as zero in the first, written off,
 * and had no line at all in the second — so the audit's net effect on a plain misplacement,
 * the commonest cause of a shortfall in a home inventory, was to lose the units for real.
 *
 * What an addition means depends on how the item is tracked, and the two are genuinely different
 * corrections rather than one with a flag:
 *
 * - **DISCRETE** — a count line with an expected quantity of zero. Whatever is entered
 *   against it is a surplus at *this* placement, which the existing per-batch reconcile already
 *   seeds. It is deliberately not a transfer: the auditor is standing at one shelf and can only
 *   report what is on it, so counting the shelf the units left is what removes them from there.
 * - **SERIALISED** — one physical unit that is simply somewhere the records do not say, so
 *   authorising moves it here rather than changing any quantity.
 *
 * Items the sheet cannot count are refused with a reason rather than silently ignored: an
 * UNTRACKED item has no quantity to reconcile, and an unlimited one is by definition never short.
 */
export function FoundHereField({ count }: { count: LocationCycleCount }) {
  const { lines, serialised, found, addFound } = count;
  const [refused, setRefused] = useState<string | null>(null);
  // Bumped on every accepted pick to remount the picker, which is what clears the text it holds:
  // the control owns its own box, so handing it a null value does not empty it.
  const [nonce, setNonce] = useState(0);

  // Everything already on the sheet, so the picker cannot offer a second line for the same lot.
  // Only the *untracked* lot of a discrete line counts: an item holding a numbered batch here may
  // still turn up as unlabelled stock, and that is a genuine find rather than a duplicate.
  const exclude = new Set<string>([
    ...lines.filter((line) => line.key === foundLineKey(line)).map((line) => line.itemId),
    ...serialised.map((line) => line.itemId),
    ...found.map((entry) => entry.itemId),
  ]);

  const onPick = useCallback(
    (itemId: string | null, item?: Item) => {
      if (itemId === null || !item) return;
      if (item.trackingMode === 'DISCRETE' && item.isUnlimited) {
        setRefused(`${item.name} is stocked without a quantity, so there is nothing here to count.`);
        return;
      }
      if (item.trackingMode !== 'DISCRETE' && item.trackingMode !== 'SERIALISED') {
        setRefused(`${item.name} is not counted by quantity, so it cannot be added to a count sheet.`);
        return;
      }
      setRefused(null);
      addFound({
        itemId: item.id,
        name: item.name,
        serialNo: item.serialNo,
        mode: item.trackingMode,
      } satisfies FoundHereEntry);
      setNonce((n) => n + 1);
    },
    [addFound],
  );

  return (
    <div className="space-y-field-gap-compact rounded-lg border border-dashed border-border p-3">
      <ItemPicker
        key={nonce}
        value={null}
        onChange={onPick}
        label="Found something that is not listed?"
        hint={FOUND_HINT}
        placeholder="Search for an item…"
        exclude={exclude}
        data-testid="found-here-picker"
      />
      {/* Always mounted so a refusal is announced when it appears rather than inserted with it. */}
      <LiveRegion className="text-xs text-warning">
        {refused !== null ? <p data-testid="found-here-refused">{refused}</p> : null}
      </LiveRegion>
    </div>
  );
}

/** Rich-Markdown help for the found-here picker (rendered by the field's info badge). */
const FOUND_HINT = [
  'Add an item you have **physically found here** that Gubbins does not record in this location.',
  'A bulk item joins the sheet with an expected quantity of **0**, so whatever you count against it is recorded as a surplus here. A serialised unit is **moved** here when you authorise.',
  'Count the location it was recorded in as well, so the units leave there too.',
].join('\n\n');
