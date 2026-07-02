import { useId, useMemo, useRef, useState } from 'react';
import { Button, FormField, Input, InfoHint, Modal, Textarea } from '@/components/foundry';
import type { Location, LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useCreateLocation } from '../mutations';
import { buildParentOptions } from '../parent-options';
import { locationColorTextClass, type LocationColor } from '../location-color';
import type { LocationKind } from '../location-kind';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationKindPicker } from './LocationKindPicker';
import {
  HINT_CAPACITY,
  HINT_COLOUR,
  HINT_DEFAULT,
  HINT_DESCRIPTION,
  HINT_KIND,
  HINT_NAME,
  HINT_PARENT,
} from './location-field-help';

/** Create a (optionally nested) location (spec §4). */
export function CreateLocationDialog({
  open,
  onClose,
  locations,
  defaultParentId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  locations: readonly LocationWithCount[];
  defaultParentId?: string | null;
  /**
   * Called with the freshly-created location after a successful save — used by the
   * Add-item dialog's inline "New location…" flow to select it without a round trip.
   */
  onCreated?: (location: Location) => void;
}) {
  const create = useCreateLocation();
  const fmt = useFormatters();
  const parentLabelId = useId();
  const colorLabelId = useId();
  const kindLabelId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>(defaultParentId ?? '');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<LocationColor | null>(null);
  const [kind, setKind] = useState<LocationKind | null>(null);
  const [capacity, setCapacity] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  // The parent choices: "top level" plus every user-created location, each carrying a
  // right-aligned item-count hint (system/archived locations are never valid parents).
  const parentOptions = useMemo(() => buildParentOptions(locations, fmt.quantity), [locations, fmt]);

  const submit = () => {
    if (name.trim().length === 0) return;
    const capacityNum = capacity.trim() === '' ? null : Number(capacity);
    create.mutate(
      {
        name: name.trim(),
        parentId: parentId || null,
        description,
        color,
        kind,
        capacity: capacityNum,
        isDefault,
      },
      {
        onSuccess: (location) => {
          setName('');
          setDescription('');
          setColor(null);
          setKind(null);
          setCapacity('');
          setIsDefault(false);
          onCreated?.(location);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add location"
      description="Locations can be nested to any depth."
      initialFocusRef={nameRef}
    >
      <div className="space-y-4">
        <FormField label="Name" hint={HINT_NAME}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Workshop, Cabinet A, Drawer 3"
            className={locationColorTextClass(color)}
          />
        </FormField>

        <div className="relative">
          <span id={parentLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            Parent (optional)
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={HINT_PARENT} />
          </span>
          <LocationSelect
            labelledBy={parentLabelId}
            value={parentId}
            onChange={setParentId}
            options={parentOptions}
          />
        </div>

        <FormField label="Description (optional)" hint={HINT_DESCRIPTION}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A note about what lives here, for your reference."
          />
        </FormField>

        <div className="relative">
          <span id={kindLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            Type (optional)
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={HINT_KIND} />
          </span>
          <LocationKindPicker labelledBy={kindLabelId} value={kind} onChange={setKind} />
        </div>

        <div className="relative">
          <span id={colorLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            Colour (optional)
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={HINT_COLOUR} />
          </span>
          <ColorSwatchPicker labelledBy={colorLabelId} value={color} onChange={setColor} />
        </div>

        <FormField label="Capacity (optional)" hint={HINT_CAPACITY}>
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="No limit"
          />
        </FormField>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="size-4 accent-primary"
          />
          Use as the default location for new items
          <InfoHint content={HINT_DEFAULT} />
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
