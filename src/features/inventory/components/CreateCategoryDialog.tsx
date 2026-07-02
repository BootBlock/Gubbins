import { useRef, useState } from 'react';
import { Button, FormField, Modal, Input } from '@/components/foundry';
import type { Category } from '@/db/repositories';
import { useCreateCategory } from '../categories';

/**
 * Quick category creation (spec §4) — a deliberately tiny dialog holding just the
 * name, for the Add-item dialog's inline "New category…" flow. It stacks on top of
 * the Add-item dialog (the Modal stack keeps Escape scoped to this one), so the
 * half-completed item form underneath is never lost. Custom fields are defined
 * afterwards in the full Categories & schemas manager.
 */
export function CreateCategoryDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the freshly-created category so the opener can select it. */
  onCreated?: (category: Category) => void;
}) {
  const create = useCreateCategory();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (category) => {
          setName('');
          onCreated?.(category);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add category"
      description="Custom fields can be defined later in the category manager."
      initialFocusRef={nameRef}
    >
      <div className="space-y-4">
        <FormField
          label="Name"
          hint={
            'The category’s display name (e.g. `Resistors`, `Hand tools`).\n\n' +
            'Categories group items and can carry **custom fields** — define those from ' +
            '**Categories & schemas** once the category exists.'
          }
        >
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Resistors"
          />
        </FormField>
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
