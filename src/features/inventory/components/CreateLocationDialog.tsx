import { useId, useMemo, useRef, useState } from 'react';
import { Button, FormField, Input, InfoHint, Modal, Textarea } from '@/components/foundry';
import type { Location, LocationWithCount } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { volumeFromDimensions } from '@/lib/volume';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCreateLocationPath } from '../mutations';
import { buildParentOptions } from '../parent-options';
import { locationColorTextClass, type LocationColor } from '../location-color';
import type { LocationKind } from '../location-kind';
import { parseLocationBranch } from '../location-path';
import { resolveDimension } from '../measure-input';
import { LocationSelect } from './LocationSelect';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { LocationDimensionsFields } from './LocationDimensionsFields';
import { LocationKindPicker } from './LocationKindPicker';
import {
  HINT_CAPACITY,
  HINT_COLOUR,
  HINT_DEFAULT,
  HINT_DESCRIPTION,
  HINT_KIND,
  HINT_NAME_CREATE,
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
  const create = useCreateLocationPath();
  const fmt = useFormatters();
  const dimensionUnit = usePreferencesStore((s) => s.dimensionUnit);
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
  const widthState = resolveDimension(width, null, dimensionUnit);
  const heightState = resolveDimension(height, null, dimensionUnit);
  const depthState = resolveDimension(depth, null, dimensionUnit);
  const derivedVolume = volumeFromDimensions(widthState.value, heightState.value, depthState.value);
  const dimensionsValid =
    widthState.issue === null && heightState.issue === null && depthState.issue === null;

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
      title="Add location"
      description="Locations can be nested to any depth."
      initialFocusRef={nameRef}
    >
      <div className="space-y-4">
        {/* The live preview sits *outside* FormField's `<label>`: FormField uses implicit label
            association, so any text inside it would fold into the Name control's accessible name. */}
        <div>
          <FormField label="Name" hint={HINT_NAME_CREATE}>
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="e.g. Workshop/Cabinet A/Drawer 3, or Garage/Box 1, Box 2, Box 3"
              className={locationColorTextClass(color)}
            />
          </FormField>
          {showPreview ? (
            <p className="mt-field-gap-compact text-xs text-muted-foreground">
              Creates{' '}
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
              {leaves.length > 1 ? ' as siblings' : null}. Existing levels are reused, not duplicated.
            </p>
          ) : null}
        </div>

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

        <div>
          <label
            className={`flex items-center gap-2 text-sm ${
              multipleLeaves ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              // A multi-sibling create has no single default, so the box is unchecked + disabled;
              // the underlying preference is kept, so removing the extra siblings restores it.
              checked={isDefault && !multipleLeaves}
              disabled={multipleLeaves}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4 accent-primary"
            />
            Use as the default location for new items
            <InfoHint content={HINT_DEFAULT} />
          </label>
          {multipleLeaves ? (
            <p className="mt-field-gap-compact text-xs text-muted-foreground">
              Only a single location can be the default, so this is unavailable while you're adding several at
              once.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || leaves.length === 0 || !dimensionsValid}>
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
