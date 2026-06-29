import { useState } from 'react';
import { Button, Input, Modal, Select } from '@/components/foundry';
import type { LocationWithCount } from '@/db/repositories';
import { useCreateLocation } from '../mutations';

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
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>(defaultParentId ?? '');

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
        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Parent (optional)</span>
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— Top level —</option>
            {locations
              .filter((l) => !l.isSystem)
              .map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
          </Select>
        </label>
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
