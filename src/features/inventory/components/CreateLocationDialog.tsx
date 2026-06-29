import { useId, useMemo, useState } from 'react';
import { Button, Input, Modal } from '@/components/foundry';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useCreateLocation } from '../mutations';
import { buildParentOptions } from '../parent-options';
import { LocationSelect } from './LocationSelect';

/** Create a (optionally nested) location (spec §4). */
export function CreateLocationDialog({
  open,
  onClose,
  locations,
  defaultParentId,
}: {
  open: boolean;
  onClose: () => void;
  locations: readonly LocationWithCount[];
  defaultParentId?: string | null;
}) {
  const create = useCreateLocation();
  const fmt = useFormatters();
  const parentLabelId = useId();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>(defaultParentId ?? '');

  // The parent choices: "top level" plus every user-created location, each carrying a
  // right-aligned item-count hint (system locations are never valid parents).
  const parentOptions = useMemo(() => buildParentOptions(locations, fmt.quantity), [locations, fmt]);

  const submit = () => {
    if (name.trim().length === 0) return;
    create.mutate(
      { name: name.trim(), parentId: parentId || null },
      {
        onSuccess: () => {
          setName('');
          onClose();
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Add location" description="Locations can be nested to any depth.">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Name</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Workshop, Cabinet A, Drawer 3"
          />
        </label>
        <div className="block">
          <span id={parentLabelId} className="mb-field-gap block text-sm font-medium">
            Parent (optional)
          </span>
          <LocationSelect
            labelledBy={parentLabelId}
            value={parentId}
            onChange={setParentId}
            options={parentOptions}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || name.trim().length === 0}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
