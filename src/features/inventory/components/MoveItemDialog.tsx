import { useId, useMemo, useState } from 'react';
import { Button, Modal } from '@/components/foundry';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useMoveItem } from '../mutations';
import { buildItemLocationOptions } from '../parent-options';
import { LocationSelect } from './LocationSelect';

/** Move an item to another location (spec §4), logging the move in the ledger. */
export function MoveItemDialog({
  item,
  open,
  onClose,
  locations,
}: {
  item: Item;
  open: boolean;
  onClose: () => void;
  locations: readonly LocationWithCount[];
}) {
  const move = useMoveItem();
  const fmt = useFormatters();
  const labelId = useId();
  const [locationId, setLocationId] = useState(item.locationId);

  // Every location is a valid destination — including the system Unassigned / In Transit
  // rows — each tinted with its colour and showing its item count.
  const options = useMemo(
    () => buildItemLocationOptions(locations, fmt.quantity),
    [locations, fmt],
  );

  const submit = () => {
    if (locationId === item.locationId) {
      onClose();
      return;
    }
    move.mutate({ id: item.id, locationId }, { onSuccess: onClose });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Move ${item.name}`} description="Choose a new location.">
      <span id={labelId} className="mb-field-gap block text-sm font-medium">
        Location
      </span>
      <LocationSelect labelledBy={labelId} value={locationId} onChange={setLocationId} options={options} />
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={move.isPending}>
          Move item
        </Button>
      </div>
    </Modal>
  );
}
