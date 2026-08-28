/**
 * `RegionEditorDialog` — draw, name, tint and populate the regions on one location photo
 * (issue #81).
 *
 * ## The pointer overlay is additive; the list is the interface
 *
 * Everything the canvas can do is reachable from the **region list** beside it: create (the Add
 * button places a default shape for the current tool), select (each row is a button), rename,
 * re-tint, delete, and place or remove items. A user who never touches the canvas loses nothing
 * but the convenience of drawing — which is the only honest way to ship a drag-to-draw surface.
 *
 * ## Why the tool doubles as the commit discriminator
 *
 * `RegionCanvas` reports every geometry change through one `onCommit`, whether it came from
 * drawing a new shape, dragging an existing one, or an arrow-key nudge. Rather than guess which,
 * the two modes are made **mutually exclusive**: a drawing tool clears the selection (so the
 * canvas has no shape to move or resize, and every commit is a *create*), and selecting a region
 * — from the list or the canvas — switches back to the select tool (so every commit is an
 * *update*). One rule, no ambiguous state, and no way for a drag of an existing region to
 * silently duplicate it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  Button,
  FormField,
  Input,
  LiveRegion,
  Modal,
  RegionCanvas,
  SegmentedRadioGroup,
  Spinner,
  buildPickerLabelMap,
  useToast,
  type SegmentedOption,
} from '@/components/foundry';
import { AddIcon, DeleteIcon, ImageIcon, UnlinkIcon } from '@/components/icons';
import type { Item, LocationPhoto, LocationRegionWithCount } from '@/db/repositories';
import type { RegionShape } from '@/db/repositories/constants';
import { useT } from '@/features/i18n';
import { serialiseGeometry, type RegionGeometry } from '../regions/geometry';
import type { DrawTool } from '../regions/draw-machine';
import {
  useAddRegion,
  useLinkItemToRegion,
  usePhotoRegions,
  useRegionItemIds,
  useRemoveRegion,
  useUpdateRegion,
} from '../location-media';
import { useInventoryItems, useItemsById } from '../queries';
import { itemDisplayName } from '../item-display';
import { isLocationColor, type LocationColor } from '../location-color';
import { usePhotoImageSrc } from '../usePhotoImageSrc';
import { ColorSwatchPicker } from './ColorSwatchPicker';
import { useErrorMessage } from '@/features/errors';

/**
 * The shape a keyboard-created region gets, per tool. Centred and comfortably clear of the edges,
 * so it is visible and immediately draggable/nudgeable without first being hunted for.
 */
function defaultGeometry(tool: DrawTool): RegionGeometry {
  switch (tool) {
    case 'circle':
      return { shape: 'circle', cx: 0.5, cy: 0.5, r: 0.15 };
    case 'polygon':
      return {
        shape: 'polygon',
        points: [
          { x: 0.5, y: 0.3 },
          { x: 0.68, y: 0.65 },
          { x: 0.32, y: 0.65 },
        ],
      };
    // A rectangle is the sensible default for `select` too — the Add button must always work,
    // whatever tool happens to be armed.
    case 'rect':
    case 'select':
      return { shape: 'rect', x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
  }
}

export function RegionEditorDialog({
  open,
  onClose,
  photo,
  locationName,
}: {
  open: boolean;
  onClose: () => void;
  photo: LocationPhoto;
  locationName: string;
}) {
  const t = useT();
  const describeError = useErrorMessage();
  const { show } = useToast();
  // Every write here can fail — most plausibly against the §7.6 storage Hard Stop, which
  // `assertWritable()` throws on. Without this the dialog would simply do nothing, which is
  // indistinguishable from having ignored the click.
  const onFailure = (error: unknown) =>
    show({
      tone: 'danger',
      message: describeError(error, t('inventory.regions.saveFailed')),
    });

  const { src, loading } = usePhotoImageSrc(photo);
  const { data: regions } = usePhotoRegions(photo.id);
  const addRegion = useAddRegion();
  const updateRegion = useUpdateRegion(photo.id);
  const removeRegion = useRemoveRegion(photo.id);

  const [tool, setTool] = useState<DrawTool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // The region a create just produced, so its name box can take focus with the placeholder name
  // selected. Held as an *id* rather than a boolean because the request outlives the create: the
  // panel only mounts once the refetched list carries the new row, so the id is what stops the
  // request landing on whichever region happens to be selected when it does.
  const [nameToFocusId, setNameToFocusId] = useState<string | null>(null);

  const rows = useMemo(() => regions ?? [], [regions]);
  const selected = rows.find((region) => region.id === selectedId) ?? null;

  const toolOptions: readonly SegmentedOption<DrawTool>[] = [
    { value: 'select', label: t('inventory.regions.tool.select') },
    { value: 'rect', label: t('inventory.regions.tool.rect') },
    { value: 'circle', label: t('inventory.regions.tool.circle') },
    { value: 'polygon', label: t('inventory.regions.tool.polygon') },
  ];

  const shapeLabel = (shape: RegionShape) =>
    shape === 'rect'
      ? t('inventory.regions.tool.rect')
      : shape === 'circle'
        ? t('inventory.regions.tool.circle')
        : t('inventory.regions.tool.polygon');

  /** Selecting always returns to the select tool — see the module header's commit discriminator. */
  const select = (id: string | null) => {
    setTool('select');
    setSelectedId(id);
    // Any deliberate selection supersedes a pending focus request. Without this the request could
    // outlive the gap between the create and the list refetch — the user selects elsewhere, the
    // panel never mounts to spend it, and it lies in wait to yank focus on some later click.
    setNameToFocusId(null);
    const region = rows.find((r) => r.id === id);
    if (region) setAnnouncement(t('inventory.regions.selected', { vars: { name: region.name } }));
  };

  /** Arming a drawing tool clears the selection, so a commit under it can only be a create. */
  const chooseTool = (next: DrawTool) => {
    setTool(next);
    setNameToFocusId(null);
    if (next !== 'select') setSelectedId(null);
  };

  const create = (geometry: RegionGeometry) => {
    const name = t('inventory.regions.defaultName');
    addRegion.mutate(
      {
        photoId: photo.id,
        name,
        shape: geometry.shape,
        geometry: serialiseGeometry(geometry),
        // Strictly above every existing region, so a shape drawn over another wins the hit
        // test. `rows.length` would not do: positions are never compacted after a delete, so
        // a photo left holding 0 and 5 would put the new region at 2 — underneath.
        position: rows.reduce((top, region) => Math.max(top, region.position + 1), 0),
      },
      {
        onSuccess: (region) => {
          setTool('select');
          setSelectedId(region.id);
          // A new region is born with a placeholder name that the user almost always replaces,
          // so the box is focused with that name selected — typing overwrites it outright.
          setNameToFocusId(region.id);
          setAnnouncement(t('inventory.regions.created', { vars: { name: region.name } }));
        },
        onError: onFailure,
      },
    );
  };

  const onCommit = (geometry: RegionGeometry) => {
    if (tool === 'select') {
      if (!selected) return;
      updateRegion.mutate(
        { id: selected.id, input: { geometry: serialiseGeometry(geometry) } },
        { onError: onFailure },
      );
      return;
    }
    create(geometry);
  };

  const confirmDelete = (region: LocationRegionWithCount) => {
    removeRegion.mutate(region.id, {
      onError: onFailure,
      onSuccess: () => {
        setPendingDeleteId(null);
        if (selectedId === region.id) setSelectedId(null);
        setAnnouncement(t('inventory.regions.deleted', { vars: { name: region.name } }));
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.regions.title')}
      description={t('inventory.regions.description')}
      className="max-w-5xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span id="region-tool-label" className="text-sm font-medium">
            {t('inventory.regions.toolLabel')}
          </span>
          <SegmentedRadioGroup
            options={toolOptions}
            value={tool}
            onChange={chooseTool}
            labelledBy="region-tool-label"
            testIdPrefix="region-tool"
          />
          <Button variant="outline" size="sm" onClick={() => create(defaultGeometry(tool))}>
            <AddIcon aria-hidden="true" />
            {t('inventory.regions.add')}
          </Button>
        </div>

        {/* Canvas beside the list on a wide dialog; stacked on a narrow one. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            {src ? (
              <RegionCanvas
                src={src}
                alt={t('inventory.locationPhotos.alt', { vars: { location: locationName } })}
                naturalWidth={photo.naturalWidth}
                naturalHeight={photo.naturalHeight}
                regions={rows}
                selectedId={selectedId}
                tool={tool}
                readOnly={false}
                onSelect={select}
                onCommit={onCommit}
                overlayLabel={t('inventory.regions.canvasLabel')}
                regionLabel={(region) =>
                  t('inventory.regions.shapeLabel', {
                    vars: { shape: shapeLabel(region.shape), name: region.name },
                  })
                }
                className="aspect-video w-full rounded-lg border border-border bg-secondary/30"
              />
            ) : (
              <div
                className="grid aspect-video w-full place-items-center rounded-lg border border-dashed border-border text-sm text-muted-foreground [&_svg]:size-6"
                data-testid="region-photo-placeholder"
              >
                {loading ? (
                  <Spinner />
                ) : (
                  <span className="flex flex-col items-center gap-2 px-4 text-center">
                    <ImageIcon aria-hidden="true" />
                    {t('inventory.locationPhotos.missing')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Selecting a region mounts the editor panel below the list, and in normal flow that
              growth resizes the whole dialog under the pointer. Beside the canvas the column
              therefore claims a fixed height and its content is taken *out* of flow, scrolling
              within that box — so the dialog is one size whether or not something is selected.
              The height is the canvas's own (a 16:9 photo at this dialog's width) plus the
              margin the editor panel needs to sit fully in view rather than clipped mid-control;
              a region holding several items still scrolls, which is the honest trade for a
              dialog that never moves under the pointer.

              Stacked, the column is the only thing in its row with no canvas height to borrow,
              so it is left in flow: there the dialog is already scrolling at full height, and
              growth extends that scroll rather than re-staging the layout. */}
          <div className="relative min-w-0 lg:h-[26rem]">
            {/* `ring-bleed-x` in place of a bare right padding: the column clips on both axes
                once it scrolls, and it holds the colour swatch picker, whose selected swatch
                draws its ring outside its own box. The bleed clears the scrollbar on the right
                exactly as the padding did, and gives that ring room on the left (issue #417). */}
            <div className="space-y-4 lg:absolute lg:inset-0 lg:overflow-y-auto lg:ring-bleed-x">
              <RegionList
                rows={rows}
                selectedId={selectedId}
                pendingDeleteId={pendingDeleteId}
                shapeLabel={shapeLabel}
                onSelect={select}
                onAskDelete={setPendingDeleteId}
                onConfirmDelete={confirmDelete}
                onCancelDelete={() => setPendingDeleteId(null)}
              />

              {selected ? (
                <SelectedRegionEditor
                  key={selected.id}
                  photoId={photo.id}
                  region={selected}
                  onError={onFailure}
                  selectName={nameToFocusId === selected.id}
                  onNameSelected={() => setNameToFocusId(null)}
                  onRename={(name) =>
                    updateRegion.mutate(
                      { id: selected.id, input: { name } },
                      {
                        onError: onFailure,
                        onSuccess: () => setAnnouncement(t('inventory.regions.updated', { vars: { name } })),
                      },
                    )
                  }
                  onRecolour={(color) =>
                    updateRegion.mutate(
                      { id: selected.id, input: { color } },
                      {
                        onError: onFailure,
                        onSuccess: () =>
                          setAnnouncement(t('inventory.regions.updated', { vars: { name: selected.name } })),
                      },
                    )
                  }
                />
              ) : null}
            </div>
          </div>
        </div>

        {/* Create / select / delete change the picture silently for a screen-reader user — the
            live region is what makes them perceivable. Always mounted; only its text changes. */}
        <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t('inventory.regions.done')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The keyboard-complete region list — the primary path, not a mirror of the canvas. */
function RegionList({
  rows,
  selectedId,
  pendingDeleteId,
  shapeLabel,
  onSelect,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  rows: readonly LocationRegionWithCount[];
  selectedId: string | null;
  pendingDeleteId: string | null;
  shapeLabel: (shape: RegionShape) => string;
  onSelect: (id: string) => void;
  onAskDelete: (id: string) => void;
  onConfirmDelete: (region: LocationRegionWithCount) => void;
  onCancelDelete: () => void;
}) {
  const t = useT();

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="regions-empty">
        {t('inventory.regions.empty')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="region-list">
      {rows.map((region) => (
        <li key={region.id} className="rounded-lg bg-secondary/30 p-1.5" data-testid="region-row">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelect(region.id)}
              aria-pressed={region.id === selectedId}
              data-testid="region-select"
              className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <span className="block truncate text-sm font-medium">{region.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {shapeLabel(region.shape)} ·{' '}
                {t('inventory.regions.itemCount', { vars: { count: region.itemCount } })}
              </span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('inventory.regions.remove')}
              onClick={() => onAskDelete(region.id)}
              className="text-destructive [&_svg]:size-3.5"
            >
              <DeleteIcon aria-hidden="true" />
            </Button>
          </div>

          {/* An inline two-step confirm rather than a nested dialog: deleting a region only
           *unplaces* its items, and the copy has to say so where the decision is made. */}
          {pendingDeleteId === region.id ? (
            <div className="mt-field-gap-compact rounded-md bg-destructive/10 p-2">
              <p className="text-xs text-destructive">
                {t('inventory.regions.removeConfirm', { vars: { name: region.name } })}
              </p>
              <div className="mt-field-gap-compact flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancelDelete}>
                  {t('inventory.regions.removeCancel')}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => onConfirmDelete(region)}>
                  {t('inventory.regions.remove')}
                </Button>
              </div>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Name, colour and item placements for the selected region. */
function SelectedRegionEditor({
  photoId,
  region,
  onRename,
  onRecolour,
  onError,
  selectName,
  onNameSelected,
}: {
  photoId: string;
  region: LocationRegionWithCount;
  onRename: (name: string) => void;
  onRecolour: (color: string | null) => void;
  /** Surfaces a failed placement — otherwise the row simply never appears, with no reason given. */
  onError: (error: unknown) => void;
  /** Focus the name box and select its text — set when this region was just created. */
  selectName: boolean;
  /** Clears the parent's request, so re-selecting this region later does not steal focus again. */
  onNameSelected: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(region.name);
  const [picked, setPicked] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectName) return;
    // Both calls, in this order: a selection in an unfocused control shows nothing and takes no
    // keystrokes, so the focus is what makes the selection mean anything.
    nameRef.current?.focus();
    nameRef.current?.select();
    onNameSelected();
  }, [selectName, onNameSelected]);

  const { data: itemIds } = useRegionItemIds(region.id);
  const ids = useMemo(() => itemIds ?? [], [itemIds]);
  const { data: itemsById } = useItemsById(ids);
  const link = useLinkItemToRegion(photoId);

  // Candidates come from a *search*, not a fixed first page: an inventory of any real size
  // would otherwise put most of its items permanently out of reach of this picker. The typed
  // text drives the query, so what the user is looking for is what gets fetched.
  const search = picked.trim();
  const { data: itemsPage } = useInventoryItems(search.length > 0 ? { search } : {}, 20);
  const candidates = useMemo(() => itemsPage?.pages.flatMap((page) => page.rows) ?? [], [itemsPage]);

  const placed = useMemo(
    () => ids.flatMap((id) => (itemsById?.get(id) ? [itemsById.get(id)!] : [])),
    [ids, itemsById],
  );
  const placedIds = useMemo(() => new Set(ids), [ids]);

  /**
   * Label → item, for the picker's suggestions and for resolving what the user typed back to a
   * row. Two items can legitimately render the same label (same name, neither serialised), and
   * matching on the label alone would silently link whichever came first — {@link
   * buildPickerLabelMap} is the one place that decides how a repeated label is told apart, shared
   * with the item and project pickers.
   */
  const byLabel = useMemo(
    () =>
      buildPickerLabelMap(
        candidates.filter((item) => !placedIds.has(item.id)),
        {
          labelFor: (item: Item) => itemDisplayName(item.name, item.serialNo),
          idFor: (item: Item) => item.id,
        },
      ),
    [candidates, placedIds],
  );

  const suggestions = useMemo(() => [...byLabel.keys()], [byLabel]);

  const addPicked = () => {
    const match = byLabel.get(picked.trim());
    if (!match) return;
    link.mutate(
      { itemId: match.id, regionId: region.id, linked: true },
      { onSuccess: () => setPicked(''), onError },
    );
  };

  const commitName = () => {
    const next = name.trim();
    if (next.length === 0 || next === region.name) return;
    onRename(next);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="region-editor-panel">
      <FormField label={t('inventory.regions.nameLabel')}>
        <Input
          ref={nameRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          placeholder={t('inventory.regions.namePlaceholder')}
        />
      </FormField>

      <div>
        <span id={`region-colour-${region.id}`} className="mb-field-gap block text-sm font-medium">
          {t('inventory.regions.colourLabel')}
        </span>
        <ColorSwatchPicker
          labelledBy={`region-colour-${region.id}`}
          value={isLocationColor(region.color) ? (region.color as LocationColor) : null}
          onChange={(color) => onRecolour(color)}
        />
      </div>

      <div>
        <p className="mb-field-gap-compact text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('inventory.regions.itemsTitle')}
        </p>
        {placed.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="region-items-empty">
            {t('inventory.regions.itemsEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {placed.map((item) => {
              const label = itemDisplayName(item.name, item.serialNo);
              return (
                <li
                  key={item.id}
                  className="flex items-center gap-2 rounded-md bg-secondary/30 px-2 py-1 text-sm"
                  data-testid="region-item-row"
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('inventory.regions.removeItem', { vars: { name: label } })}
                    onClick={() =>
                      link.mutate({ itemId: item.id, regionId: region.id, linked: false }, { onError })
                    }
                    className="[&_svg]:size-3.5"
                  >
                    <UnlinkIcon aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <span id={`region-add-item-${region.id}`} className="mb-field-gap block text-sm font-medium">
            {t('inventory.regions.addItem')}
          </span>
          <Autocomplete
            value={picked}
            onChange={setPicked}
            suggestions={suggestions}
            placeholder={t('inventory.regions.addItemPlaceholder')}
            aria-labelledby={`region-add-item-${region.id}`}
            data-testid="region-add-item"
          />
        </div>
        <Button variant="outline" onClick={addPicked} disabled={!byLabel.has(picked.trim())}>
          {t('inventory.regions.addItemAction')}
        </Button>
      </div>
    </div>
  );
}
