import { useId, useMemo, useRef, useState } from 'react';
import {
  Button,
  FormField,
  InfoHint,
  Input,
  RailModal,
  SegmentedRadioGroup,
  Textarea,
  type RailTab,
} from '@/components/foundry';
import { DeleteIcon, EditIcon, ImageIcon, PackageIcon, MoveIcon } from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { LocationPhotoManager } from './LocationPhotoManager';
import type { DeadStockMode } from '@/db/repositories/constants';
import { DEAD_STOCK_DAYS_BOUNDS } from '@/features/settings/settings';
import { DEAD_STOCK_MODE_OPTIONS } from '../dead-stock-options';
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
import { LocationTagEditor } from './TagEditor';
import { LocationFieldsEditor } from './LocationFieldsEditor';
import { locationFullness } from '../location-fullness';
import { LocationFullnessBar } from './LocationFullnessBar';
import {
  HINT_CAPACITY,
  HINT_COLOUR,
  HINT_DEAD_STOCK_DAYS,
  HINT_DEAD_STOCK_MODE,
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
 *
 * Presented as a {@link RailModal}, mirroring `ItemDetailDialog`: **Details** is the whole
 * pre-existing form, unchanged field-for-field, and **Photos** (issue #81) is the location's
 * photo grid and the way into the region editor. The rail mounts only the active tab's panel,
 * so the photo queries never run for a user who is merely renaming a shelf.
 *
 * The footer — delete, cancel, save — is pinned below the panel rather than living inside
 * Details, because it acts on the location as a whole, not on one tab's fields.
 */
export function EditLocationDialog({
  open,
  onClose,
  location,
  locations,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  /** The location being edited (with its live item count). */
  location: LocationWithCount;
  /** All locations (flat) — for the parent picker and the breadcrumb path. */
  locations: readonly LocationWithCount[];
  /**
   * Delete this location. Rendered as a left-aligned destructive action in the footer —
   * deletion is a considered, spacious decision, not a cramped hover-row afterthought.
   * The caller owns the confirm-or-delete flow (a non-empty location prompts first, since
   * deleting it re-parents its items to Unassigned). Omit to hide the control.
   */
  onDelete?: () => void;
}) {
  const update = useUpdateLocation();
  const fmt = useFormatters();
  const t = useT();
  const enabledFeatures = useEnabledFeatures();
  const parentLabelId = useId();
  const colorLabelId = useId();
  const kindLabelId = useId();
  const deadStockLabelId = useId();
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
  const [deadStockMode, setDeadStockMode] = useState<DeadStockMode>(location.deadStockMode);
  const [deadStockDays, setDeadStockDays] = useState(
    location.deadStockDays != null ? String(location.deadStockDays) : '',
  );
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
  // Blank ⇒ no override (defer to the location above, then the global default), matching
  // how the repository persists it.
  const deadStockDaysValue = deadStockDays.trim() === '' ? null : Math.floor(Number(deadStockDays));
  const deadStockDaysValid =
    deadStockDays.trim() === '' ||
    (Number.isFinite(Number(deadStockDays)) &&
      Number(deadStockDays) >= DEAD_STOCK_DAYS_BOUNDS.min &&
      Number(deadStockDays) <= DEAD_STOCK_DAYS_BOUNDS.max);
  const dirty =
    trimmed !== location.name ||
    (parentId || null) !== location.parentId ||
    descValue !== (location.description ?? null) ||
    color !== (isLocationColor(location.color) ? location.color : null) ||
    kind !== (isLocationKind(location.kind) ? location.kind : null) ||
    capacityValue !== location.capacity ||
    isDefault !== location.isDefault ||
    deadStockMode !== location.deadStockMode ||
    deadStockDaysValue !== location.deadStockDays;

  const kindLabel = locationKindLabel(location.kind);
  const fullness = locationFullness(location.itemCount, location.capacity);

  const submit = () => {
    if (trimmed.length === 0 || !dirty || !capacityValid || !deadStockDaysValid) return;
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
          deadStockMode,
          deadStockDays: deadStockDaysValue,
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save changes to this location.'),
      },
    );
  };

  const details = (
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

      <div>
        <span className="mb-field-gap block text-sm font-medium">Tags (optional)</span>
        <LocationTagEditor locationId={location.id} />
      </div>

      {/* Custom-field values this location can pass down to its contents (issue #97).
            Saves per-row on change rather than with the dialog's Save button, matching
            LocationTagEditor above — both edit rows in their own tables, not columns of
            the location being edited. */}
      <LocationFieldsEditor locationId={location.id} />

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

      {/* Dead-stock reporting for everything stored here (issue #92). The mode and the
            idle threshold are independent, so a location can set a house threshold for its
            subtree without also opting its contents in. */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="relative">
          <span id={deadStockLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            Dead-stock reporting
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={HINT_DEAD_STOCK_MODE} />
          </span>
          <SegmentedRadioGroup
            options={DEAD_STOCK_MODE_OPTIONS}
            value={deadStockMode}
            onChange={setDeadStockMode}
            labelledBy={deadStockLabelId}
            testIdPrefix="location-dead-stock-mode"
          />
        </div>

        <FormField
          label="Idle threshold (optional)"
          hint={HINT_DEAD_STOCK_DAYS}
          error={
            deadStockDaysValid
              ? undefined
              : `Idle threshold must be between ${DEAD_STOCK_DAYS_BOUNDS.min} and ${DEAD_STOCK_DAYS_BOUNDS.max} days.`
          }
        >
          <Input
            type="number"
            min={DEAD_STOCK_DAYS_BOUNDS.min}
            max={DEAD_STOCK_DAYS_BOUNDS.max}
            step={1}
            inputMode="numeric"
            value={deadStockDays}
            onChange={(e) => setDeadStockDays(e.target.value)}
            placeholder="Use the default"
            data-testid="location-dead-stock-days"
          />
        </FormField>
      </div>

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
            <dd className="mt-1">
              <LocationFullnessBar fullness={fullness} />
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
    </div>
  );

  // The Photos tab is gated on the `location-photos` capability, exactly as ItemDetailDialog
  // gates its feature-backed sections: switching the module off removes the way in, never the
  // data. Details is always first, so the rail's default selection is unchanged.
  const tabs: readonly RailTab[] = [
    {
      id: 'details',
      label: t('inventory.location.detailsTab'),
      icon: <EditIcon />,
      content: details,
    },
    ...(enabledFeatures.has('location-photos')
      ? [
          {
            id: 'photos',
            label: t('inventory.locationPhotos.tab'),
            icon: <ImageIcon />,
            content: <LocationPhotoManager locationId={location.id} locationName={location.name} />,
          },
        ]
      : []),
  ];

  return (
    <RailModal
      open={open}
      onClose={onClose}
      title="Edit location"
      description="Rename this location, move it, or change how it looks and behaves."
      className="max-w-3xl"
      railAriaLabel={t('inventory.location.railLabel')}
      idPrefix="edit-location"
      tabs={tabs}
      initialFocusRef={nameRef}
      footer={
        <div className="w-full space-y-2">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            {onDelete ? (
              <Button
                variant="destructive"
                onClick={onDelete}
                disabled={update.isPending}
                data-testid="edit-location-delete"
              >
                <DeleteIcon />
                Delete location
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={
                  update.isPending || trimmed.length === 0 || !dirty || !capacityValid || !deadStockDaysValid
                }
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      }
    />
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
