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
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DeleteIcon,
  EditIcon,
  ImageIcon,
  PackageIcon,
  MoveIcon,
  ReportIcon,
} from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { LocationPhotoManager } from './LocationPhotoManager';
import type { DeadStockMode } from '@/db/repositories/constants';
import { DEAD_STOCK_DAYS_BOUNDS } from '@/features/settings/settings';
import { DEAD_STOCK_MODE_OPTIONS } from '../dead-stock-options';
import { useFormatters } from '@/lib/useFormatters';
import { volumeFromDimensions } from '@/lib/volume';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useUpdateLocation } from '../mutations';
import { collectDescendantIds, locationPath } from '../location-tree';
import { buildParentOptions } from '../parent-options';
import { isLocationColor, locationColorTextClass, type LocationColor } from '../location-color';
import { isLocationKind, locationKindLabel, type LocationKind } from '../location-kind';
import { dimensionToInput, resolveDimension } from '../measure-input';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationDimensionsFields } from './LocationDimensionsFields';
import { LocationKindPicker } from './LocationKindPicker';
import { LocationKindIcon } from './LocationKindIcon';
import { LocationTagEditor } from './TagEditor';
import { LocationFieldsEditor } from './LocationFieldsEditor';
import { LocationStats } from './LocationStats';
import { locationFullness } from '../location-fullness';
import { LocationFullnessBar } from './LocationFullnessBar';
import { useErrorMessage } from '@/features/errors';
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
  onToggleArchive,
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
  /**
   * Archive this location if it's live, or restore it if it's already archived — a single,
   * reversible lifecycle toggle sitting beside Delete in the footer. Like deletion, it moved
   * here out of the cramped hover row into this considered context. The caller reads the
   * location's archived state to decide which way to flip it. Omit to hide the control.
   */
  onToggleArchive?: () => void;
}) {
  const update = useUpdateLocation();
  const fmt = useFormatters();
  const t = useT();
  const dimensionUnit = usePreferencesStore((s) => s.dimensionUnit);
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
  // Internal size (issue #457): shown/entered in the user's dimension unit, stored canonical mm.
  // Initialised from the stored mm re-expressed in the current unit (like capacity above); the
  // dialog remounts per location, so no re-sync effect is needed.
  const [width, setWidth] = useState(() => dimensionToInput(location.width, dimensionUnit));
  const [height, setHeight] = useState(() => dimensionToInput(location.height, dimensionUnit));
  const [depth, setDepth] = useState(() => dimensionToInput(location.depth, dimensionUnit));
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

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
  // Each dimension resolves its dirty flag + canonical-mm value against its stored value, so an
  // untouched field never re-saves via the unit round-trip's floating-point error, and a bad
  // entry surfaces its issue and keeps the stored value rather than clearing it (issue #345).
  const widthState = resolveDimension(width, location.width, dimensionUnit);
  const heightState = resolveDimension(height, location.height, dimensionUnit);
  const depthState = resolveDimension(depth, location.depth, dimensionUnit);
  const derivedVolume = volumeFromDimensions(widthState.value, heightState.value, depthState.value);
  const dimensionsValid =
    widthState.issue === null && heightState.issue === null && depthState.issue === null;
  const dirty =
    trimmed !== location.name ||
    (parentId || null) !== location.parentId ||
    descValue !== (location.description ?? null) ||
    color !== (isLocationColor(location.color) ? location.color : null) ||
    kind !== (isLocationKind(location.kind) ? location.kind : null) ||
    capacityValue !== location.capacity ||
    isDefault !== location.isDefault ||
    deadStockMode !== location.deadStockMode ||
    deadStockDaysValue !== location.deadStockDays ||
    widthState.dirty ||
    heightState.dirty ||
    depthState.dirty;

  const kindLabel = locationKindLabel(location.kind);
  const fullness = locationFullness(location.itemCount, location.capacity);
  const archived = location.archivedAt != null;

  const submit = () => {
    if (trimmed.length === 0 || !dirty || !capacityValid || !deadStockDaysValid || !dimensionsValid) return;
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
          // Canonical mm; an untouched field keeps its exact stored value (widthState.value).
          width: widthState.value,
          height: heightState.value,
          depth: depthState.value,
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(describeError(e, 'Could not save changes to this location.')),
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

      <LocationDimensionsFields
        dimensionUnit={dimensionUnit}
        width={width}
        height={height}
        depth={depth}
        onWidthChange={setWidth}
        onHeightChange={setHeight}
        onDepthChange={setDepth}
        states={{ width: widthState, height: heightState, depth: depthState }}
        derivedVolume={derivedVolume}
      />

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
    {
      id: 'stats',
      label: t('inventory.locationStats.tab'),
      icon: <ReportIcon />,
      // The rail mounts only the active panel, so the aggregate queries never run until the
      // user opens this tab — a rename of a shelf pays nothing for it.
      content: <LocationStats locationId={location.id} hasChildren={childCount > 0} />,
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
            {/* Lifecycle actions — Delete, then the Archive/Restore toggle immediately to its
                right. Both act on the location as a whole, so they group together, apart from the
                Cancel/Save pair that acts on the edits. */}
            {onDelete || onToggleArchive ? (
              <div className="flex flex-wrap gap-2">
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
                ) : null}
                {onToggleArchive ? (
                  <Button
                    variant="outline"
                    onClick={onToggleArchive}
                    disabled={update.isPending}
                    // Colourised for its meaning without shouting over the solid-red Delete:
                    // restoring picks up the success glyph tone, archiving the neutral "set aside"
                    // one — the same semantics the row used to carry. The icon inherits the colour.
                    className={archived ? 'text-glyph-success' : 'text-glyph-neutral'}
                    data-testid="edit-location-archive"
                  >
                    {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                    {archived ? 'Restore location' : 'Archive location'}
                  </Button>
                ) : null}
              </div>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              {/* "Cancel" implies discarding work, so it is only honest once there is work to
                  discard — an untouched dialog is simply being closed. */}
              <Button variant="ghost" onClick={onClose} data-testid="edit-location-dismiss">
                {dirty ? t('inventory.location.cancel') : t('inventory.location.close')}
              </Button>
              <Button
                onClick={submit}
                disabled={
                  update.isPending ||
                  trimmed.length === 0 ||
                  !dirty ||
                  !capacityValid ||
                  !deadStockDaysValid ||
                  !dimensionsValid
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
