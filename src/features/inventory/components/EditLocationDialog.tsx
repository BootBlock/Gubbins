import { useMemo, useState } from 'react';
import { Button, Input, Modal, Select } from '@/components/foundry';
import { PackageIcon, MoveIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useUpdateLocation } from '../mutations';
import { collectDescendantIds, locationPath } from '../location-tree';

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
  const [name, setName] = useState(location.name);
  const [parentId, setParentId] = useState<string>(location.parentId ?? '');
  const [error, setError] = useState<string | null>(null);

  // A location may not move under itself or any of its own descendants (the repo
  // guards this too, but excluding them from the picker is the kinder UX).
  const forbidden = useMemo(
    () => collectDescendantIds(location.id, locations),
    [location.id, locations],
  );
  const childCount = useMemo(
    () => locations.filter((l) => l.parentId === location.id).length,
    [locations, location.id],
  );
  const path = useMemo(() => locationPath(location.id, locations), [location.id, locations]);

  const trimmed = name.trim();
  const dirty = trimmed !== location.name || (parentId || null) !== location.parentId;

  const submit = () => {
    if (trimmed.length === 0 || !dirty) return;
    setError(null);
    update.mutate(
      { id: location.id, input: { name: trimmed, parentId: parentId || null } },
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

        <label className="block">
          <span className="mb-field-gap block text-sm font-medium">Parent</span>
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— Top level —</option>
            {locations
              .filter((l) => !l.isSystem && !forbidden.has(l.id))
              .map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
          </Select>
        </label>

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
