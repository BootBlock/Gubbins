import { useId, useMemo, useRef, useState } from 'react';
import { Button, FormField, InfoHint, Input, Modal, Textarea } from '@/components/foundry';
import { PackageIcon, MoveIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useUpdateLocation } from '../mutations';
import { collectDescendantIds, locationPath } from '../location-tree';
import { buildParentOptions } from '../parent-options';
import { isLocationColor, locationColorTextClass, type LocationColor } from '../location-color';
import { isLocationKind, locationKindLabel, type LocationKind } from '../location-kind';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationKindPicker } from './LocationKindPicker';
import { LocationKindIcon } from './LocationKindIcon';
import { locationFullness } from '../location-fullness';
import {
  HINT_CAPACITY,
  HINT_COLOUR,
  HINT_DEFAULT,
  HINT_DESCRIPTION,
  HINT_KIND,
  HINT_NAME,
  HINT_PARENT,
} from './location-field-help';

/**
 * Edit an existing location (spec §4): rename it, move it under a different parent, change
 * its type/colour/capacity, mark it the default, and review its read-only metadata (items
 * stored, sub-locations, fullness, last change). System locations (Unassigned / In-Transit)
 * are never edited, so this dialog is only opened for mutable rows.
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
  const kindLabelId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(location.name);
  const [parentId, setParentId] = useState<string>(location.parentId ?? '');
  const [description, setDescription] = useState(location.description ?? '');
  const [color, setColor] = useState<LocationColor | null>(
    isLocationColor(location.color) ? location.color : null,
  );
  const [kind, setKind] = useState<LocationKind | null>(isLocationKind(location.kind) ? location.kind : null);
  const [capacity, setCapacity] = useState(location.capacity != null ? String(location.capacity) : '');
  const [isDefault, setIsDefault] = useState(location.isDefault);
  const [error, setError] = useState<string | null>(null);

  // A location may not move under itself or any of its own descendants (the repo
  // guards this too, but excluding them from the picker is the kinder UX).
  const forbidden = useMemo(() => collectDescendantIds(location.id, locations), [location.id, locations]);
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
  const capacityValue = capacity.trim() === '' ? null : Math.floor(Number(capacity));
  const capacityValid =
    capacity.trim() === '' || (Number.isFinite(Number(capacity)) && Number(capacity) >= 0);
  const dirty =
    trimmed !== location.name ||
    (parentId || null) !== location.parentId ||
    descValue !== (location.description ?? null) ||
    color !== (isLocationColor(location.color) ? location.color : null) ||
    kind !== (isLocationKind(location.kind) ? location.kind : null) ||
    capacityValue !== location.capacity ||
    isDefault !== location.isDefault;

  const kindLabel = locationKindLabel(location.kind);
  const fullness = locationFullness(location.itemCount, location.capacity);

  const submit = () => {
    if (trimmed.length === 0 || !dirty || !capacityValid) return;
    setError(null);
    update.mutate(
      {
        id: location.id,
        input: {
          name: trimmed,
          parentId: parentId || null,
          description: descValue,
          color,
          kind,
          capacity: capacityValue,
          isDefault,
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save changes to this location.'),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit location"
      description="Rename this location, move it, or change how it looks and behaves."
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
            Parent
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

        <FormField
          label="Capacity (optional)"
          hint={HINT_CAPACITY}
          error={capacityValid ? undefined : 'Capacity must be a whole number of 0 or more.'}
        >
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

        {/* Read-only metadata for the location. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-secondary/40 p-3 text-sm">
          <InfoRow
            icon={<PackageIcon />}
            label="Items stored"
            value={
              fullness
                ? `${fmt.quantity(location.itemCount)} / ${fmt.quantity(location.capacity!)}`
                : fmt.quantity(location.itemCount)
            }
          />
          <InfoRow icon={<MoveIcon />} label="Sub-locations" value={fmt.quantity(childCount)} />
          {fullness ? (
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Fullness</dt>
              <dd className="mt-1 flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={
                      fullness.over ? 'h-full rounded-full bg-destructive' : 'h-full rounded-full bg-primary'
                    }
                    style={{ width: `${fullness.percent}%` }}
                  />
                </div>
                <span className="tabular-nums text-xs text-muted-foreground">{fullness.percent}%</span>
              </dd>
            </div>
          ) : null}
          {kindLabel ? (
            <div className="col-span-2">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Type</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 font-medium [&_svg]:size-4">
                <LocationKindIcon kind={location.kind} />
                {kindLabel}
              </dd>
            </div>
          ) : null}
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
          <Button
            onClick={submit}
            disabled={update.isPending || trimmed.length === 0 || !dirty || !capacityValid}
          >
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
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
