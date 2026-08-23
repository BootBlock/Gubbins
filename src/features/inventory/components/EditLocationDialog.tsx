import { useId, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  FormField,
  GlyphPickerButton,
  InfoHint,
  Input,
  RailModal,
  SegmentedRadioGroup,
  Textarea,
  humanizeGlyphName,
  type RailTab,
} from '@/components/foundry';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  DeleteIcon,
  EditIcon,
  FolderIcon,
  HistoryIcon,
  ImageIcon,
  PackageIcon,
  MoveIcon,
  ReportIcon,
} from '@/components/icons';
import type { LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermission } from '@/features/users/usePermission';
import { LocationPhotoManager } from './LocationPhotoManager';
import type { DeadStockMode } from '@/db/repositories/constants';
import { DEAD_STOCK_DAYS_BOUNDS } from '@/features/settings/settings';
import { DEAD_STOCK_MODE_OPTIONS } from '../dead-stock-options';
import { useFormatters } from '@/lib/useFormatters';
import { volumeFromDimensions, volumeSystemForDimensionUnit } from '@/lib/volume';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useUpdateLocation } from '../mutations';
import { collectDescendantIds, locationPath } from '../location-tree';
import { buildParentOptions } from '../parent-options';
import { isLocationColor, locationColorTextClass, type LocationColor } from '../location-color';
import {
  dimensionToInput,
  resolveDimension,
  resolvePackingPercent,
  resolveVolume,
  volumeToInput,
} from '../measure-input';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationAdvancedVolumeFields } from './LocationAdvancedVolumeFields';
import { LocationDimensionsFields } from './LocationDimensionsFields';
import { LocationIcon } from './LocationIcon';
import { LocationTagEditor } from './TagEditor';
import { LocationFieldsEditor } from './LocationFieldsEditor';
import { LocationActivityLog } from './LocationActivityLog';
import { LocationStats } from './LocationStats';
import { useLocationFullness } from '../use-location-fullness';
import { LocationFullnessBar } from './LocationFullnessBar';
import { LocationFullnessCaption } from './LocationFullnessCaption';
import { useErrorMessage } from '@/features/errors';

/**
 * Edit an existing location (spec §4): rename it, move it under a different parent, change
 * its type/colour/capacity, mark it the default, and review its read-only metadata (items
 * stored, sub-locations, fullness, last change). System locations (Unassigned / In-Transit)
 * are never edited, so this dialog is only opened for mutable rows.
 *
 * Presented as a {@link RailModal}, mirroring `ItemDetailDialog`: **Details** is the whole
 * pre-existing form, unchanged field-for-field, **History** (issue #691) is the record of what has
 * been done to this location, and **Photos** (issue #81) is the location's photo grid and the way
 * into the region editor. The rail mounts only the active tab's panel, so neither the activity nor
 * the photo queries ever run for a user who is merely renaming a shelf.
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
  const defaultPackingFactor = usePreferencesStore((s) => s.defaultPackingFactor);
  // The usable-volume override is entered in a fixed unit for the dimension system (litres for
  // metric, cubic feet for imperial) — deterministic, unlike the per-value display unit.
  const volumeEntryUnit = volumeSystemForDimensionUnit(dimensionUnit) === 'imperial' ? 'ft3' : 'l';
  const enabledFeatures = useEnabledFeatures();
  const mayViewAudit = usePermission('audit:view');
  const parentLabelId = useId();
  const colorLabelId = useId();
  const iconFieldId = useId();
  const deadStockLabelId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(location.name);
  const [parentId, setParentId] = useState<string>(location.parentId ?? '');
  const [description, setDescription] = useState(location.description ?? '');
  const [color, setColor] = useState<LocationColor | null>(
    isLocationColor(location.color) ? location.color : null,
  );
  const [icon, setIcon] = useState<string | null>(location.icon);
  const [capacity, setCapacity] = useState(location.capacity != null ? String(location.capacity) : '');
  // Picking-sweep position (issue #461); blank = unplaced (sorts after every placed location).
  const [walkOrder, setWalkOrder] = useState(location.walkOrder != null ? String(location.walkOrder) : '');
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
  // Advanced overrides (issue #457): usable volume in the entry unit, packing efficiency as a %.
  const [usableVolume, setUsableVolume] = useState(() =>
    volumeToInput(location.usableVolume, volumeEntryUnit),
  );
  const [packingPercent, setPackingPercent] = useState(() =>
    location.packingFactor != null ? String(Math.round(location.packingFactor * 100)) : '',
  );
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
  // Blank ⇒ unplaced (null), the same clear-vs-set discipline as capacity above.
  const walkOrderValue = walkOrder.trim() === '' ? null : Math.floor(Number(walkOrder));
  const walkOrderValid =
    walkOrder.trim() === '' || (Number.isFinite(Number(walkOrder)) && Number(walkOrder) >= 0);
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
  const usableVolumeState = resolveVolume(usableVolume, location.usableVolume, volumeEntryUnit);
  const packingState = resolvePackingPercent(packingPercent, location.packingFactor);
  const dimensionsValid =
    widthState.issue === null &&
    heightState.issue === null &&
    depthState.issue === null &&
    usableVolumeState.issue === null &&
    !packingState.outOfRange;
  const dirty =
    trimmed !== location.name ||
    (parentId || null) !== location.parentId ||
    descValue !== (location.description ?? null) ||
    color !== (isLocationColor(location.color) ? location.color : null) ||
    icon !== location.icon ||
    capacityValue !== location.capacity ||
    walkOrderValue !== location.walkOrder ||
    isDefault !== location.isDefault ||
    deadStockMode !== location.deadStockMode ||
    deadStockDaysValue !== location.deadStockDays ||
    widthState.dirty ||
    heightState.dirty ||
    depthState.dirty ||
    usableVolumeState.dirty ||
    packingState.dirty;

  // Volumetric fullness when the location has a measured size (issue #457), else the count gauge.
  const fullness = useLocationFullness(location);
  const archived = location.archivedAt != null;

  const submit = () => {
    if (
      trimmed.length === 0 ||
      !dirty ||
      !capacityValid ||
      !walkOrderValid ||
      !deadStockDaysValid ||
      !dimensionsValid
    ) {
      return;
    }
    setError(null);
    update.mutate(
      {
        id: location.id,
        input: {
          name: trimmed,
          parentId: parentId || null,
          description: descValue,
          color,
          icon,
          capacity: capacityValue,
          walkOrder: walkOrderValue,
          isDefault,
          deadStockMode,
          deadStockDays: deadStockDaysValue,
          // Canonical mm; an untouched field keeps its exact stored value (widthState.value).
          width: widthState.value,
          height: heightState.value,
          depth: depthState.value,
          // Advanced overrides — usable volume in canonical mm³, packing factor as a fraction.
          usableVolume: usableVolumeState.value,
          packingFactor: packingState.value,
        },
      },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(describeError(e, t('inventory.location.saveError'))),
      },
    );
  };

  const details = (
    <div className="space-y-4">
      <FormField label={t('inventory.location.field.name')} hint={t('inventory.location.hint.name')}>
        <Input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={t('inventory.location.field.namePlaceholderEdit')}
          className={locationColorTextClass(color)}
        />
      </FormField>

      <div className="relative">
        <span id={parentLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
          {t('inventory.location.field.parent')}
        </span>
        <span className="absolute right-0 top-0.5">
          <InfoHint content={t('inventory.location.hint.parent')} />
        </span>
        <LocationSelect
          labelledBy={parentLabelId}
          value={parentId}
          onChange={setParentId}
          options={parentOptions}
        />
      </div>

      <FormField
        label={t('inventory.location.field.description')}
        hint={t('inventory.location.hint.description')}
      >
        <Textarea
          sizeKey="location.description"
          autoGrow
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('inventory.location.field.descriptionPlaceholder')}
        />
      </FormField>

      <div>
        <span className="mb-field-gap block text-sm font-medium">{t('inventory.location.field.tags')}</span>
        <LocationTagEditor locationId={location.id} />
      </div>

      {/* Custom-field values this location can pass down to its contents (issue #97).
            Saves per-row on change rather than with the dialog's Save button, matching
            LocationTagEditor above — both edit rows in their own tables, not columns of
            the location being edited. */}
      <LocationFieldsEditor locationId={location.id} />

      {/* Explicit <label htmlFor> (a <button> is a labelable element) rather than
          FormField's implicit-label wrap, which is meant for a single input. */}
      <div className="relative">
        <label htmlFor={iconFieldId} className="mb-field-gap block pr-6 text-sm font-medium">
          {t('inventory.location.field.icon')}
        </label>
        <span className="absolute right-0 top-0.5">
          <InfoHint content={t('inventory.location.hint.icon')} />
        </span>
        <GlyphPickerButton
          id={iconFieldId}
          value={icon}
          onChange={setIcon}
          fallback={FolderIcon}
          placeholder={t('inventory.location.field.iconPlaceholder')}
          title={t('inventory.location.field.iconPickerTitle')}
          clearable
        />
      </div>

      <div className="relative">
        <span id={colorLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
          {t('inventory.location.field.colour')}
        </span>
        <span className="absolute right-0 top-0.5">
          <InfoHint content={t('inventory.location.hint.colour')} />
        </span>
        <ColorSwatchPicker labelledBy={colorLabelId} value={color} onChange={setColor} />
      </div>

      <FormField
        label={t('inventory.location.field.capacity')}
        hint={t('inventory.location.hint.capacity')}
        error={capacityValid ? undefined : t('inventory.location.capacity.error')}
      >
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder={t('inventory.location.field.capacityPlaceholder')}
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

      <LocationAdvancedVolumeFields
        volumeUnit={volumeEntryUnit}
        usableVolume={usableVolume}
        onUsableVolumeChange={setUsableVolume}
        usableVolumeState={usableVolumeState}
        packingPercent={packingPercent}
        onPackingPercentChange={setPackingPercent}
        packingOutOfRange={packingState.outOfRange}
        defaultPackingPercent={Math.round(defaultPackingFactor * 100)}
      />

      <FormField
        label={t('inventory.location.walkOrder.field')}
        hint={t('inventory.location.hint.walkOrder')}
        error={walkOrderValid ? undefined : t('inventory.location.walkOrder.error')}
      >
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          value={walkOrder}
          onChange={(e) => setWalkOrder(e.target.value)}
          placeholder={t('inventory.location.walkOrder.placeholder')}
          data-testid="location-walk-order"
        />
      </FormField>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        {t('inventory.location.field.default')}
        <InfoHint content={t('inventory.location.hint.default')} />
      </label>

      {/* Dead-stock reporting for everything stored here (issue #92). The mode and the
            idle threshold are independent, so a location can set a house threshold for its
            subtree without also opting its contents in. */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="relative">
          <span id={deadStockLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            {t('inventory.location.deadStock.legend')}
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={t('inventory.location.hint.deadStockMode')} />
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
          label={t('inventory.location.idleThreshold.label')}
          hint={t('inventory.location.hint.deadStockDays')}
          error={
            deadStockDaysValid
              ? undefined
              : t('inventory.location.idleThreshold.error', {
                  // Pass as strings so the bound renders verbatim (e.g. 3650, not the
                  // locale-grouped "3,650" a numeric var would produce).
                  vars: { min: String(DEAD_STOCK_DAYS_BOUNDS.min), max: String(DEAD_STOCK_DAYS_BOUNDS.max) },
                })
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
            placeholder={t('inventory.location.idleThreshold.placeholder')}
            data-testid="location-dead-stock-days"
          />
        </FormField>
      </div>

      {/* Read-only metadata for the location. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-secondary/40 p-3 text-sm">
        <InfoRow
          icon={<PackageIcon />}
          label={t('inventory.location.meta.itemsStored')}
          // The count/limit form depends on a *count* capacity, not on whether a fullness bar
          // shows — a location can now be full by volume without a count limit set (issue #457).
          value={
            location.capacity != null && location.capacity > 0
              ? `${fmt.quantity(location.itemCount)} / ${fmt.quantity(location.capacity)}`
              : fmt.quantity(location.itemCount)
          }
        />
        <InfoRow
          icon={<MoveIcon />}
          label={t('inventory.location.meta.subLocations')}
          value={fmt.quantity(childCount)}
        />
        {fullness ? (
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('inventory.location.meta.fullness')}
            </dt>
            <dd className="mt-1 space-y-1">
              <LocationFullnessBar fullness={fullness} />
              <LocationFullnessCaption fullness={fullness} />
            </dd>
          </div>
        ) : null}
        {location.icon ? (
          <div className="col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('inventory.location.meta.icon')}
            </dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-medium [&_svg]:size-4">
              <LocationIcon icon={location.icon} />
              {humanizeGlyphName(location.icon)}
            </dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('inventory.location.meta.path')}
          </dt>
          <dd className="mt-0.5 truncate font-medium" title={path}>
            {path}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('inventory.location.meta.lastChanged')}
          </dt>
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
      content: <LocationStats location={location} hasChildren={childCount > 0} />,
    },
    // The per-location ledger is the same audit trail the Activity screen shows, so it answers to
    // the same permission (issue #522) — otherwise it is a second, unguarded door to exactly what
    // `audit:view` is defined to withhold.
    ...(mayViewAudit
      ? [
          {
            id: 'history',
            label: t('inventory.locationActivity.tab'),
            icon: <HistoryIcon />,
            // Like Stats above, the rail mounts only the active panel — so a rename pays nothing
            // for the activity read, and the record is only paged in when somebody asks to see it.
            content: <LocationActivityLog locationId={location.id} />,
          },
        ]
      : []),
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
      title={t('inventory.location.edit.title')}
      description={t('inventory.location.edit.description')}
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
                    {t('inventory.location.delete')}
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
                    {archived ? t('inventory.location.restore') : t('inventory.location.archive')}
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
                  !walkOrderValid ||
                  !deadStockDaysValid ||
                  !dimensionsValid
                }
              >
                {t('inventory.location.save')}
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
