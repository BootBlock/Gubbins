import { useId, useMemo, useState } from 'react';
import { Button, Input, Modal, Textarea } from '@/components/foundry';
import { PackageIcon, MoveIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useUpdateLocation } from '../mutations';
import { collectDescendantIds, locationPath } from '../location-tree';
import { buildParentOptions } from '../parent-options';
import { isLocationColor, type LocationColor } from '../location-color';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';

/**
 * Edit an existing location (spec §4): rename it, move it under a different parent,
 * and review its read-only metadata (items stored, sub-locations, last change). The
 * only mutable fields the schema affords are `name` and `parentId` — everything else
 * shown here is informational. System locations (Unassigned) are never edited, so
 * this dialog is only opened for mutable rows.
 */
export function EditLocationDialog({
  open,
  onClose,
  location,
  locations,
}: {
  open: boolean;
  onClose: () => void;
  /** The location being edited (with its live item count). */
  location: LocationWithCount;
  /** All locations (flat) — for the parent picker and the breadcrumb path. */
  locations: readonly LocationWithCount[];
}) {
  const update = useUpdateLocation();
  const fmt = useFormatters();
  const parentLabelId = useId();
  const colorLabelId = useId();
  const [name, setName] = useState(location.name);
  const [parentId, setParentId] = useState<string>(location.parentId ?? '');
  const [description, setDescription] = useState(location.description ?? '');
  const [color, setColor] = useState<LocationColor | null>(
    isLocationColor(location.color) ? location.color : null,
  );
  const [error, setError] = useState<string | null>(null);

  // A location may not move under itself or any of its own descendants (the repo
  // guards this too, but excluding them from the picker is the kinder UX).
  const forbidden = useMemo(
    () => collectDescendantIds(location.id, locations),
    [location.id, locations],
  );
  const parentOptions = useMemo(
    () => buildParentOptions(locations, fmt.quantity, forbidden),
    [locations, fmt, forbidden],
  );
  const childCount = useMemo(
    () => locations.filter((l) => l.parentId === location.id).length,
    [locations, location.id],
  );
  const path = useMemo(() => locationPath(location.id, locations), [location.id, locations]);

  const trimmed = name.trim();
  // Treat blank/whitespace-only description as "none" so it compares against the stored
  // value the way the repository persists it (it collapses blanks to NULL).
  const descValue = description.trim() || null;
  const dirty =
    trimmed !== location.name ||
    (parentId || null) !== location.parentId ||
    descValue !== (location.description ?? null) ||
    color !== (isLocationColor(location.color) ? location.color : null);

  const submit = () => {
    if (trimmed.length === 0 || !dirty) return;
    setError(null);
    update.mutate(
      {
        id: location.id,
        input: { name: trimmed, parentId: parentId || null, description: descValue, color },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) =>
          setError(e instanceof Error ? e.message : 'Could not save changes to this location.'),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit location"
      description="Rename this location or move it elsewhere in the hierarchy."
    >
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
            Parent
          </span>
          <LocationSelect
            labelledBy={parentLabelId}
            value={parentId}
            onChange={setParentId}
            options={parentOptions}
          />
        </div>

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Description (optional)</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A note about what lives here, for your reference."
          />
        </label>

        <div className="block">
          <span id={colorLabelId} className="mb-field-gap block text-sm font-medium">
            Colour (optional)
          </span>
          <ColorSwatchPicker labelledBy={colorLabelId} value={color} onChange={setColor} />
        </div>

        {/* Read-only metadata for the location. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-secondary/40 p-3 text-sm">
          <InfoRow icon={<PackageIcon />} label="Items stored" value={fmt.quantity(location.itemCount)} />
          <InfoRow
            icon={<MoveIcon />}
            label="Sub-locations"
            value={fmt.quantity(childCount)}
          />
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Path</dt>
            <dd className="mt-0.5 truncate font-medium" title={path}>
              {path}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Last changed</dt>
            <dd className="mt-0.5 font-medium tabular-nums">{fmt.dateTime(location.updatedAt)}</dd>
          </div>
        </dl>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending || trimmed.length === 0 || !dirty}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}
