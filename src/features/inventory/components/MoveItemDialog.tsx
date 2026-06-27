import { useState } from 'react';
import { Button, Modal, Select } from '@/components/foundry';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useMoveItem } from '../mutations';

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
  const [locationId, setLocationId] = useState(item.locationId);

  const submit = () => {
    if (locationId === item.locationId) {
      onClose();
      return;
    }
    move.mutate({ id: item.id, locationId }, { onSuccess: onClose });
  };

  return (
    <Modal open={open} onClose={onClose} title={`Move ${item.name}`} description="Choose a new location.">
      <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.name}
          </option>
        ))}
      </Select>
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
