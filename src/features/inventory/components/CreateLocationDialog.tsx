import { useId, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, FormField, Input, InfoHint, Modal, Textarea } from '@/components/foundry';
import type { Location, LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import { volumeFromDimensions, volumeSystemForDimensionUnit } from '@/lib/volume';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCreateLocationPath } from '../mutations';
import { buildParentOptions } from '../parent-options';
import { locationColorTextClass, type LocationColor } from '../location-color';
import type { LocationKind } from '../location-kind';
import { parseLocationBranch } from '../location-path';
import { resolveDimension, resolvePackingPercent, resolveVolume } from '../measure-input';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationAdvancedVolumeFields } from './LocationAdvancedVolumeFields';
import { LocationDimensionsFields } from './LocationDimensionsFields';
import { LocationKindPicker } from './LocationKindPicker';

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
  const create = useCreateLocationPath();
  const fmt = useFormatters();
  const t = useT();
  const dimensionUnit = usePreferencesStore((s) => s.dimensionUnit);
  const defaultPackingFactor = usePreferencesStore((s) => s.defaultPackingFactor);
  const volumeEntryUnit = volumeSystemForDimensionUnit(dimensionUnit) === 'imperial' ? 'ft3' : 'l';
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
  // Internal size (issue #457): entered in the user's dimension unit, stored canonical mm. A
  // fresh location has no stored value, so each field resolves against `null` — this gives the
  // same clear-vs-error semantics the item editor uses (a bad number blocks the save, blank
  // means "not measured"), and the parsed mm values feed both the volume preview and the save.
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [depth, setDepth] = useState('');
  const [usableVolume, setUsableVolume] = useState('');
  const [packingPercent, setPackingPercent] = useState('');
  const widthState = resolveDimension(width, null, dimensionUnit);
  const heightState = resolveDimension(height, null, dimensionUnit);
  const depthState = resolveDimension(depth, null, dimensionUnit);
  const usableVolumeState = resolveVolume(usableVolume, null, volumeEntryUnit);
  const packingState = resolvePackingPercent(packingPercent, null);
  const derivedVolume = volumeFromDimensions(widthState.value, heightState.value, depthState.value);
  const dimensionsValid =
    widthState.issue === null &&
    heightState.issue === null &&
    depthState.issue === null &&
    usableVolumeState.issue === null &&
    !packingState.outOfRange;

  // The parent choices: "top level" plus every user-created location, each carrying a
  // right-aligned item-count hint (system/archived locations are never valid parents).
  const parentOptions = useMemo(() => buildParentOptions(locations, fmt.quantity), [locations, fmt]);

  // The name can describe a whole branch at once: `/` or `\` nests levels *down* the tree and a
  // `,` at the leaf fans *across* into siblings (missing ancestors are added, existing ones
  // reused; each leaf carries the metadata below). Parse once for both the submit guard and the
  // live "what this will create" preview.
  const { ancestors, leaves } = useMemo(() => parseLocationBranch(name), [name]);
  // Fanning the leaf out into several siblings means there's no single location to make the
  // default, so the Default toggle is unavailable while that's the case.
  const multipleLeaves = leaves.length > 1;
  // Only show the preview when it says more than the plain single-name create already conveys.
  const showPreview = ancestors.length > 0 || multipleLeaves;

  const submit = () => {
    if (leaves.length === 0 || !dimensionsValid) return;
    const capacityNum = capacity.trim() === '' ? null : Number(capacity);
    create.mutate(
      {
        // Pass the raw name through so the repository parses the branch; a plain name (no
        // separator) is a single leaf and behaves exactly like a plain create.
        name: name.trim(),
        parentId: parentId || null,
        description,
        color,
        kind,
        capacity: capacityNum,
        // Only a single location can be the default, so a multi-sibling create never sets it.
        isDefault: multipleLeaves ? false : isDefault,
        // Canonical mm; each fans out onto every leaf sibling (createPath spreads the input).
        width: widthState.value,
        height: heightState.value,
        depth: depthState.value,
        // Advanced overrides — usable volume (mm³) and packing factor (fraction).
        usableVolume: usableVolumeState.value,
        packingFactor: packingState.value,
      },
      {
        onSuccess: (created) => {
          setName('');
          setDescription('');
          setColor(null);
          setKind(null);
          setCapacity('');
          setIsDefault(false);
          setWidth('');
          setHeight('');
          setDepth('');
          setUsableVolume('');
          setPackingPercent('');
          // Fanning out siblings yields several leaves; the inline picker selects the first.
          if (created[0]) onCreated?.(created[0]);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.location.add.title')}
      description={t('inventory.location.add.description')}
      initialFocusRef={nameRef}
    >
      <div className="space-y-4">
        {/* The live preview sits *outside* FormField's `<label>`: FormField uses implicit label
            association, so any text inside it would fold into the Name control's accessible name. */}
        <div>
          <FormField
            label={t('inventory.location.field.name')}
            hint={t('inventory.location.hint.nameCreate')}
          >
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder={t('inventory.location.field.namePlaceholderCreate')}
              className={locationColorTextClass(color)}
            />
          </FormField>
          {showPreview ? (
            <p className="mt-field-gap-compact text-xs text-muted-foreground">
              {t('inventory.location.preview.creates')}{' '}
              {ancestors.map((level, i) => (
                <span key={`ancestor-${i}`}>
                  {i > 0 ? <span aria-hidden="true"> › </span> : null}
                  <span className="font-medium text-foreground">{level}</span>
                </span>
              ))}
              {ancestors.length > 0 ? <span aria-hidden="true"> › </span> : null}
              {leaves.map((leaf, i) => (
                <span key={`leaf-${i}`}>
                  {i > 0 ? ', ' : null}
                  <span className="font-medium text-foreground">{leaf}</span>
                </span>
              ))}
              {leaves.length > 1 ? <> {t('inventory.location.preview.siblings')}</> : null}.{' '}
              {t('inventory.location.preview.reused')}
            </p>
          ) : null}
        </div>

        <div className="relative">
          <span id={parentLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            {t('inventory.location.field.parentOptional')}
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
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('inventory.location.field.descriptionPlaceholder')}
          />
        </FormField>

        <div className="relative">
          <span id={kindLabelId} className="mb-field-gap block pr-6 text-sm font-medium">
            {t('inventory.location.field.type')}
          </span>
          <span className="absolute right-0 top-0.5">
            <InfoHint content={t('inventory.location.hint.kind')} />
          </span>
          <LocationKindPicker labelledBy={kindLabelId} value={kind} onChange={setKind} />
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

        <div>
          <label
            className={`flex items-center gap-2 text-sm ${
              multipleLeaves ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer'
            }`}
          >
            <Checkbox
              // A multi-sibling create has no single default, so the box is unchecked + disabled;
              // the underlying preference is kept, so removing the extra siblings restores it.
              checked={isDefault && !multipleLeaves}
              disabled={multipleLeaves}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            {t('inventory.location.field.default')}
            <InfoHint content={t('inventory.location.hint.default')} />
          </label>
          {multipleLeaves ? (
            <p className="mt-field-gap-compact text-xs text-muted-foreground">
              {t('inventory.location.field.defaultUnavailable')}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('inventory.location.cancel')}
          </Button>
          <Button onClick={submit} disabled={create.isPending || leaves.length === 0 || !dimensionsValid}>
            {t('inventory.location.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
