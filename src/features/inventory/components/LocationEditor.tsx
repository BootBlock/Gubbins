import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/foundry';
import type { Item } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useLocations } from '../queries';
import { useMoveItem } from '../mutations';
import { buildItemLocationOptions } from '../parent-options';
import { isLocationFull } from '../location-fullness';
import { LocationSelect } from './LocationSelect';

/**
 * Location facet of the item detail dialog (spec §4) — change *where* the item lives
 * without leaving the editor. The write routes through {@link useMoveItem}, the same
 * ledger-logged `MOVED` mutation the standalone Move dialog uses (per-location stock is
 * consolidated into the target, Phase 25), so it is never a bare `location_id` update.
 *
 * Draft state is local; left on the current location the Save button stays disabled. Every
 * non-archived location is a valid destination — including the system Unassigned / In
 * Transit rows — and the item's current home is always kept even if it happens to be
 * archived. A move to an at-capacity location is allowed, with a soft heads-up.
 */
export function LocationEditor({ item }: { item: Item }) {
  const { data: locations } = useLocations();
  const move = useMoveItem();
  const fmt = useFormatters();
  const labelId = useId();
  const [locationId, setLocationId] = useState(item.locationId);

  // Re-sync the draft when the persisted location changes (open, after a save, or sync).
  useEffect(() => {
    setLocationId(item.locationId);
  }, [item.locationId]);

  const rows = useMemo(() => locations?.rows ?? [], [locations]);
  const options = useMemo(
    () => buildItemLocationOptions(rows, fmt.quantity, item.locationId),
    [rows, fmt, item.locationId],
  );

  // Soft heads-up when the destination is already at/over capacity (the move is allowed).
  const fullLocation = useMemo(() => {
    const loc = rows.find((l) => l.id === locationId);
    return loc && locationId !== item.locationId && isLocationFull(loc.itemCount, loc.capacity) ? loc : null;
  }, [rows, locationId, item.locationId]);

  const dirty = locationId !== item.locationId;
  const save = () => move.mutate({ id: item.id, locationId });

  return (
    <div className="space-y-3">
      <div>
        <span id={labelId} className="mb-field-gap block text-sm font-medium">
          Location
        </span>
        <LocationSelect labelledBy={labelId} value={locationId} onChange={setLocationId} options={options} />
        {fullLocation ? (
          <p className="mt-1 text-xs text-warning">
            {fullLocation.name} is at capacity ({fullLocation.itemCount}/{fullLocation.capacity}). You can
            still move it here.
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || move.isPending}
          data-testid="location-editor-save"
        >
          {dirty ? 'Move item' : 'Saved'}
        </Button>
      </div>
    </div>
  );
}
