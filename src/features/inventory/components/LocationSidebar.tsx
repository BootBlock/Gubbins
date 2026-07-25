import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  measureElement as measureElementRect,
  observeElementRect,
  useVirtualizer,
  type Virtualizer,
} from '@tanstack/react-virtual';

import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import {
  Button,
  Checkbox,
  Input,
  InputClearButton,
  LiveRegion,
  Modal,
  Spinner,
  Tooltip,
  useSearchEscapeToClear,
  useToast,
} from '@/components/foundry';
import { AddIcon, DeleteIcon, PackageIcon, SearchIcon, TagIcon } from '@/components/icons';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { useFeature } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { useReportWriteFailure } from '@/features/errors';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import {
  EMPTY_VOLUME_TOTALS,
  isVolumetricFullness,
  resolveLocationFullness,
  type VolumetricFullness,
} from '../location-fullness';
import { locationColorTextClass } from '../location-color';
import { locationPath } from '../labels/location-label';
import {
  collectDescendantIds,
  locationsMatchingQuery,
  matchingWithAncestors,
  pruneArchivedTree,
  pruneTreeToIds,
  type VisibleTreeRow,
} from '../location-tree';
import { useLocationTagIndex } from '../tags';
import { ALL_ITEMS_ID, useLocationSidebar } from '../useLocationSidebar';
import { useLocationExpansionStore } from '../useLocationExpansionStore';
import { useArchiveLocation, useMoveItem, useUpdateLocation } from '../mutations';
import { LocationTreeItem } from './LocationTreeItem';
import { LocationKindIcon } from './LocationKindIcon';
import { CreateLocationDialog } from './CreateLocationDialog';
import { EditLocationDialog } from './EditLocationDialog';
import { PrintLocationLabelDialog } from './PrintLocationLabelDialog';

/**
 * Above this many visible rows the tree switches from "render every row" to a scrolling window
 * (issue #129). Deliberately well clear of a normal inventory's location count: a modest tree keeps
 * plain, fully-rendered DOM — every row available to drag-and-drop and to `Ctrl+F` — and only a
 * tree big enough for the DOM cost to actually bite pays for windowing.
 */
const VIRTUALISE_ROW_THRESHOLD = 150;

/** Starting guess for a row's height; the virtualiser measures the real ones as they mount. */
const TREE_ROW_ESTIMATE_PX = 34;

/** Starting guess for the scroll port's height, until it is measured for real. */
const INITIAL_VIEWPORT_ESTIMATE_PX = 600;

/**
 * Location navigation sidebar (spec §4): the nested, self-referential hierarchy
 * with live item counts. Selecting a location filters the item list; deleting one
 * re-parents its items to Unassigned (handled by the repository). The system
 * Unassigned location is shown but cannot be deleted.
 *
 * Accessibility (spec §3 / §2.4.1 — Phase 39): rendered as a WAI-ARIA APG `tree`.
 * The whole tree is a **single tab stop** (roving `tabindex`); once focused, the
 * arrow keys navigate it — Up/Down between visible rows, Right to expand / enter a
 * child, Left to collapse / step out to the parent, Home/End to jump, Enter/Space
 * to select, and Delete to remove a (non-system) location. The stateful glue (focus,
 * expansion, rename, delete, keyboard handling) lives in {@link useLocationSidebar},
 * which delegates the pure navigation maths to `resolveTreeKey` (`../tree-keyboard`).
 */
export function LocationSidebar({
  tree,
  flat,
  selectedId,
  onSelect,
  totalCount,
  compact = false,
}: {
  tree: readonly LocationTreeNode[];
  flat: readonly LocationWithCount[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  totalCount: number;
  /**
   * Render for the off-canvas {@link Drawer} the Inventory screen moves this pane into on a
   * compact viewport (issue #147): fill the drawer's width rather than the fixed master-pane
   * column, and let the drawer's own header carry the visible "Locations" title — the section
   * heading below stays in the accessibility tree (it labels the `tree`) but is not shown twice.
   */
  compact?: boolean;
}) {
  const archive = useArchiveLocation();
  const moveItem = useMoveItem();
  const updateLocation = useUpdateLocation();
  // `useUpdateLocation` has no hook-level reporter (the Edit dialog surfaces its own errors), so
  // the drag-to-nest re-parent fired here reports its own failure (#389).
  const reportLocationUpdate = useReportWriteFailure(
    'inventory.writeError.heading.locationUpdate',
    'common.writeFailed',
  );
  const toast = useToast();
  // Announce a drag-and-drop move (WCAG 4.1.3) — the pointer-only drop has no other feedback
  // for assistive tech, and the moved item/location may leave the current view.
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(() => flat.filter((l) => l.archivedAt).length, [flat]);
  // Hide archived branches (and their subtrees) unless the user opts in; navigation,
  // counts and rendering all operate on the same filtered view for consistency.
  const visibleTree = useMemo(
    () => (showArchived ? tree : pruneArchivedTree(tree as LocationTreeNode[])),
    [tree, showArchived],
  );
  const visibleFlat = useMemo(
    () => (showArchived ? flat : flat.filter((l) => !l.archivedAt)),
    [flat, showArchived],
  );

  // Tag filter (issue #84): narrow the tree to locations carrying any of the selected tags,
  // keeping their ancestors so the matches stay reachable in context — structurally the same
  // filter layer as "Show archived" above. Stale selections (a tag renamed/removed off every
  // location) are dropped so a filter can never strand the user on an empty tree.
  const tagIndex = useLocationTagIndex();
  const [activeTagIds, setActiveTagIds] = useState<ReadonlySet<string>>(() => new Set());
  // Stable per fetch (the `?? []` fallback would otherwise be a fresh array every render, churning
  // the memo below); `tagIndex.data` is the query's cached, referentially-stable object.
  const filterTags = useMemo(() => tagIndex.data?.tags ?? [], [tagIndex.data]);
  const effectiveTagIds = useMemo(() => {
    const available = new Set(filterTags.map((t) => t.id));
    return new Set([...activeTagIds].filter((id) => available.has(id)));
  }, [activeTagIds, filterTags]);
  const toggleTagFilter = (id: string) =>
    setActiveTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Name search (issue #129): the location tree is the screen's primary navigation axis, so
  // finding a deeply nested bin must not mean expanding branches by hand. Structurally this is a
  // third filter layer over the same "match → keep ancestors → prune" pipeline as the tag chips
  // and "Show archived" above; matching itself lives in the pure `locationsMatchingQuery`.
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = search.trim().length > 0;
  // Escape clears the box before it means anything else, via the shared searchable-surface seam.
  useSearchEscapeToClear(searching, searchRef, () => setSearch(''));
  const searchMatches = useMemo(() => locationsMatchingQuery(visibleFlat, search), [visibleFlat, search]);

  const filtering = effectiveTagIds.size > 0 || searching;
  const { shownTree, shownFlat, keptIds } = useMemo(() => {
    if (!filtering) return { shownTree: visibleTree, shownFlat: visibleFlat, keptIds: undefined };
    const byLocation = tagIndex.data?.byLocation;
    const matches = new Set<string>();
    for (const loc of visibleFlat) {
      // Both filters must agree — narrowing by tag *and* by name is an intersection, so each
      // keystroke refines the chip selection rather than widening past it.
      if (effectiveTagIds.size > 0) {
        const tags = byLocation?.get(loc.id);
        if (!tags || ![...effectiveTagIds].some((id) => tags.has(id))) continue;
      }
      if (searching && !searchMatches.has(loc.id)) continue;
      matches.add(loc.id);
    }
    const keep = matchingWithAncestors(matches, visibleFlat);
    return {
      shownTree: pruneTreeToIds(visibleTree as LocationTreeNode[], keep),
      shownFlat: visibleFlat.filter((l) => keep.has(l.id)),
      keptIds: keep,
    };
  }, [effectiveTagIds, filtering, searchMatches, searching, tagIndex.data, visibleTree, visibleFlat]);

  // Keep the persisted expansion overrides bounded: drop entries for locations that no
  // longer exist (deleted since a prior session) so localStorage doesn't accumulate dead
  // ids over the app's lifetime. Pruned against the *full* flat list — not the archived-
  // filtered view — so hiding archived branches never discards their remembered state.
  const pruneExpansion = useLocationExpansionStore((s) => s.prune);
  useEffect(() => {
    // Never prune against an empty list — that's the initial pre-load state (there are
    // always at least the system locations), and it would wipe every remembered entry.
    if (flat.length === 0) return;
    pruneExpansion(new Set(flat.map((l) => l.id)));
  }, [flat, pruneExpansion]);

  // Virtualisation plumbing (issue #129). The virtualiser can only be created once the row list
  // exists, and the row list needs `isOpen` from the hook below — which in turn wants to scroll
  // the virtualiser when the keyboard jumps to an off-window row. These two refs break that cycle:
  // the row ids and the live virtualiser are published after each render, and the stable
  // `scrollRowIntoView` handed to the hook reads them at call time.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowIdsRef = useRef<readonly string[]>([]);
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const scrollRowIntoView = useCallback((id: string) => {
    const index = rowIdsRef.current.indexOf(id);
    if (index >= 0) virtualizerRef.current?.scrollToIndex(index, { align: 'auto' });
  }, []);

  const {
    addOpen,
    setAddOpen,
    addParentId,
    editLocation,
    setEditLocation,
    confirmDelete,
    setConfirmDelete,
    confirmDeleteNow,
    deleteLocation,
    focusedId,
    setFocusedId,
    renamingId,
    isOpen,
    visibleRows,
    toggle,
    select,
    commitRename,
    endRename,
    requestDelete,
    setRowRef,
    onKeyDown,
  } = useLocationSidebar({
    tree: shownTree,
    flat: shownFlat,
    selectedId,
    onSelect,
    // While a filter is on, every retained ancestor opens so the matches are visible without
    // hand-expanding — and closes back to the user's own shape when the filter clears.
    forceExpandedIds: keptIds,
    scrollRowIntoView,
  });

  // Printable location-label dialog (Phase 73) — co-located like Edit/Delete above. Gated on
  // the Label printing module (Modular UI): with it off, the per-location action disappears.
  const labelsEnabled = useFeature('labels');
  const [printLabelNode, setPrintLabelNode] = useState<LocationTreeNode | null>(null);

  // Whether the dragged location may be nested under `targetId` (spec §4 drag-to-nest, §7.5.3):
  // never under itself or one of its own descendants (that would be a cycle), and not under its
  // current parent (a no-op). Computed over the full flat list so ancestry is always complete.
  const canNest = (draggedId: string, targetId: string) => {
    if (collectDescendantIds(draggedId, flat).has(targetId)) return false;
    return flat.find((l) => l.id === draggedId)?.parentId !== targetId;
  };

  // Re-parent a dragged location under `targetId`. The repository re-validates the move and
  // cycle-checks it (§7.5.3); on success we expand the new parent so the moved child is visible
  // and announce the move for assistive tech. Unnesting stays in the Edit dialog's Parent field.
  const nestLocation = (draggedId: string, targetId: string) => {
    // Refuse a second re-parent while one is still in flight. Each nest reshapes the tree through
    // an invalidation round-trip that takes a moment; letting the user spam drops would stack
    // concurrent re-parents whose cached `flat` view is stale between them. One at a time keeps the
    // gesture predictable — the atomic DB-side guard in LocationRepository is the correctness
    // backstop; this is the UX one.
    if (updateLocation.isPending) return;
    const dragged = flat.find((l) => l.id === draggedId);
    const target = flat.find((l) => l.id === targetId);
    if (!dragged || !target) return;
    // Announce the move as it starts (not just on success): the re-parent takes a moment and the
    // dropped row also shows a spinner (see `nestingId`), so pointer and AT users both get
    // immediate feedback that something is happening.
    setMoveAnnouncement(`Moving ${dragged.name} into ${target.name}…`);
    updateLocation.mutate(
      { id: draggedId, input: { parentId: targetId } },
      {
        onSuccess: () => {
          toggle(targetId, true);
          setMoveAnnouncement(`${dragged.name} moved into ${target.name}.`);
        },
        onError: (error) => {
          // Clear the "Moving…" cue so AT isn't left mid-sentence, and surface why (#389).
          setMoveAnnouncement('');
          reportLocationUpdate(error);
        },
      },
    );
  };

  // The location whose drag-to-nest re-parent is currently in flight (or null). The row it
  // points at shows a spinner until the tree reshapes, so the multi-second wait isn't silent.
  const nestingId = updateLocation.isPending ? (updateLocation.variables?.id ?? null) : null;

  // Move a dragged item into `targetId`. The move itself settles fast, but the sidebar counts
  // only refresh after an invalidation round-trip — so on its own the drop looks like nothing
  // happened. Give layered, immediate feedback instead: an AT cue that the move started + a
  // spinner on the receiving row while it's in flight (see `movingItemToId`), then a toast
  // confirming the result. The toast viewport is itself `aria-live`, so it announces the result
  // for assistive tech — the live region only carries the "Moving…" start, never a second
  // "moved" message that would double-announce.
  const moveItemToLocation = (itemId: string, itemName: string, targetId: string, targetName: string) => {
    setMoveAnnouncement(`Moving ${itemName} to ${targetName}…`);
    moveItem.mutate(
      { id: itemId, locationId: targetId },
      {
        onSuccess: () => toast.show({ tone: 'success', message: `Moved ${itemName} to ${targetName}.` }),
        // No `onError` here: `useMoveItem` now reports a failed move itself (issue #307), and
        // its toast carries the reason the write was rejected — more actionable than repeating
        // the names back. A second handler here would only double-toast the one failure.
      },
    );
  };

  // The location currently receiving a dragged item (its move in flight), or null — the row it
  // points at shows a spinner so the drop isn't silent until the counts refresh.
  const movingItemToId = moveItem.isPending ? (moveItem.variables?.locationId ?? null) : null;

  const t = useT();

  // Global packing-factor preference, bound once here so each tree row's volumetric fullness is
  // resolved without every (virtualised) row re-reading the store. Feeds `volumeFullnessFor` below.
  const packingFactor = usePreferencesStore((s) => s.defaultPackingFactor);
  // Resolve a location's *volumetric* fullness (issue #457) for its tree row's fill bar — null
  // unless the location has a measured internal size, so count-only rows show no bar. Only the
  // volume mode is surfaced here (the count text keeps its own count-based tint), so a count-mode
  // reading from the resolver is narrowed away.
  const volumeFullnessFor = (node: LocationTreeNode): VolumetricFullness | null => {
    const fullness = resolveLocationFullness(node, node.volumeTotals ?? EMPTY_VOLUME_TOTALS, packingFactor);
    return fullness && isVolumetricFullness(fullness) ? fullness : null;
  };

  // Every row the tree shows, in render order: the synthetic "All items" row, then the location
  // rows the controller flattened (collapsed subtrees omitted). Reusing its list — rather than
  // flattening a second time here — is what guarantees the markup, the ARIA set positions, the
  // virtualiser and the keyboard navigation all describe the same rows.
  const rowIds = [ALL_ITEMS_ID, ...visibleRows.map((row) => row.node.id)];
  // "All items" sits alongside the top-level locations, so it counts towards their ARIA set.
  const topLevelSetSize = shownTree.length + 1;

  // Windowing kicks in only once the tree is genuinely long. Below the threshold every row stays
  // in the DOM exactly as before — no absolute positioning, no measurement, and drag-to-nest and
  // the roving-tabindex focus all work against real nodes. Above it the DOM cost stops tracking
  // the location count, which is what makes a few hundred locations navigable.
  const virtualize = rowIds.length > VIRTUALISE_ROW_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rowIds.length,
    // Kept subscribed even below the threshold (where the plain branch renders instead). Toggling
    // it as a filter crosses the threshold would tear the virtualiser down in the same commit that
    // unmounts every measured row, which React flags as a re-entrant flush.
    enabled: true,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_ESTIMATE_PX,
    getItemKey: (index) => rowIds[index] ?? index,
    overscan: 12,
    // A viewport guess for the first paint, before the scroll port has been measured.
    initialRect: { width: 0, height: INITIAL_VIEWPORT_ESTIMATE_PX },
    // …and the same floor applied to every later measurement. A window sized from a zero-height
    // port contains no rows at all, so a tree measured mid-layout (or in any environment that
    // doesn't compute one) would render *nothing* rather than a short list — a blank sidebar is a
    // far worse failure than a few rows more than strictly needed.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) =>
        cb({ width: rect.width, height: rect.height || INITIAL_VIEWPORT_ESTIMATE_PX }),
      ),
    // Same floor per row. A rendered row is never really zero-tall, and taking a zero measurement
    // at face value collapses every row onto the same offset — after which the virtualiser's
    // position lookup can land anywhere in the list.
    measureElement: (el, entry, instance) => measureElementRect(el, entry, instance) || TREE_ROW_ESTIMATE_PX,
  });
  // Published for the event-time `scrollRowIntoView` above (never read during render).
  useEffect(() => {
    virtualizerRef.current = virtualizer;
    rowIdsRef.current = rowIds;
  });

  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col gap-2',
        // In the drawer, fill the panel so the tree keeps its own inner scroll and the search
        // box and archived toggle stay pinned, rather than scrolling away with it.
        compact ? 'w-full flex-1' : 'w-64 shrink-0 large-format:w-72',
      )}
    >
      <div className={cn('flex shrink-0 items-center px-1', compact ? 'justify-end' : 'justify-between')}>
        <h2
          id="locations-heading"
          className={cn(
            'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
            // In the drawer the same word is already the panel's `<h2>`; keep this one for
            // the tree's `aria-labelledby` rather than printing "Locations" twice.
            compact && 'sr-only',
          )}
        >
          {t('inventory.locations.title')}
        </h2>
        <Tooltip content="Create a new location. Locations can be nested to any depth." triggerTabIndex={-1}>
          <span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Add location"
              onClick={() => setAddOpen(true)}
            >
              <AddIcon className="text-glyph-success" />
            </Button>
          </span>
        </Tooltip>
      </div>

      {/* Name search. `pr-9` reserves the clear button's lane so the two never overlap. */}
      <div className="relative shrink-0 px-1">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('inventory.locations.search.placeholder')}
          aria-label={t('inventory.locations.search.label')}
          className={cn('pl-9', searching && 'pr-9')}
        />
        {searching ? (
          <InputClearButton
            label={t('inventory.locations.search.clear')}
            onClick={() => {
              setSearch('');
              searchRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2"
          />
        ) : null}
      </div>

      {filterTags.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1 px-1" role="group" aria-label="Filter locations by tag">
          {filterTags.map((tag) => {
            const active = effectiveTagIds.has(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleTagFilter(tag.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors [&_svg]:size-3',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:bg-secondary/70',
                )}
              >
                <TagIcon aria-hidden />
                {tag.name}
              </button>
            );
          })}
          {effectiveTagIds.size > 0 ? (
            <button
              type="button"
              onClick={() => setActiveTagIds(new Set())}
              className="px-1 text-xs text-muted-foreground underline hover:text-foreground"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* APG tree: a single keydown handler on the role="tree" container drives roving-tabindex
          navigation. The container is also the scroll port — the tree owns its own scrolling so a
          long location list never pushes the archived toggle off the screen, and so the virtualiser
          has an element to measure. The inner wrappers are `presentation` so the treeitems stay
          direct children of the tree in the accessibility tree. */}
      <div
        ref={scrollRef}
        role="tree"
        aria-labelledby="locations-heading"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto"
        onKeyDown={onKeyDown}
      >
        {virtualize ? (
          <div role="presentation" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => (
              <div
                key={virtualRow.key}
                role="presentation"
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full pb-0.5"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(virtualRow.index)}
              </div>
            ))}
          </div>
        ) : (
          <div role="presentation" className="space-y-0.5">
            {rowIds.map((id, index) => (
              <Fragment key={id}>{renderRow(index)}</Fragment>
            ))}
          </div>
        )}
      </div>

      {filtering && shownFlat.length === 0 ? (
        <p className="shrink-0 px-1 text-xs text-muted-foreground">
          {searching
            ? t('inventory.locations.search.empty', { vars: { query: search.trim() } })
            : t('inventory.locations.tags.empty')}
        </p>
      ) : null}

      {archivedCount > 0 ? (
        <label className="flex shrink-0 cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
          <Checkbox
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="size-3.5"
          />
          Show archived ({archivedCount})
        </label>
      ) : null}

      {/* Mounted only while open so the parent default is re-seeded from the current
          selection on every open (the dialog captures `defaultParentId` on mount). */}
      {addOpen ? (
        <CreateLocationDialog
          open
          onClose={() => setAddOpen(false)}
          locations={flat}
          defaultParentId={addParentId}
        />
      ) : null}
      {editLocation ? (
        <EditLocationDialog
          open
          onClose={() => setEditLocation(null)}
          location={editLocation}
          locations={flat}
          onDelete={() => {
            // Deletion moved out of the cramped hover row into this considered context. Close
            // the dialog, then route through the same confirm-or-delete flow as the keyboard
            // `Delete` key (a non-empty location still prompts before re-parenting its items).
            const loc = editLocation;
            setEditLocation(null);
            requestDelete(loc.id, loc.name, loc.itemCount);
          }}
          onToggleArchive={() => {
            // Archiving/restoring also moved off the hover row into the dialog footer, beside
            // Delete. It's a reversible lifecycle toggle, so close the dialog and flip the state
            // in one tap — the sidebar's "Show archived" toggle governs whether the row stays
            // in view afterwards.
            const loc = editLocation;
            setEditLocation(null);
            archive.mutate({ id: loc.id, archived: loc.archivedAt == null });
          }}
        />
      ) : null}
      {printLabelNode ? (
        <PrintLocationLabelDialog
          open
          onClose={() => setPrintLabelNode(null)}
          location={{
            id: printLabelNode.id,
            name: printLabelNode.name,
            path: locationPath(printLabelNode.id, flat),
          }}
        />
      ) : null}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete location?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" still holds ${confirmDelete.itemCount} ${plural(confirmDelete.itemCount, 'item')}. Deleting it will move ${confirmDelete.itemCount === 1 ? 'it' : 'them'} to Unassigned.`
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleteLocation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirmDeleteNow}
            disabled={deleteLocation.isPending}
            data-testid="confirm-delete-location"
          >
            {deleteLocation.isPending ? <Spinner /> : <DeleteIcon />}
            Delete location
          </Button>
        </div>
      </Modal>

      {/* Announce drag-and-drop moves (pointer-only, so no other status reaches AT). */}
      <LiveRegion visuallyHidden data-testid="location-move-live-region">
        {moveAnnouncement ? <p>{moveAnnouncement}</p> : null}
      </LiveRegion>
    </aside>
  );

  /**
   * Render one row of {@link rowIds} by index — the seam the virtualiser needs. Index 0 is the
   * synthetic "All items" row; the rest map 1:1 onto the flattened location rows. Going through an
   * index (rather than recursing) means the windowed and unwindowed paths render identical markup.
   */
  function renderRow(index: number): ReactNode {
    if (index === 0) {
      return (
        <LocationTreeItem
          id={ALL_ITEMS_ID}
          ref={setRowRef(ALL_ITEMS_ID)}
          level={1}
          posInSet={1}
          setSize={topLevelSetSize}
          selected={selectedId === null}
          focused={focusedId === ALL_ITEMS_ID}
          icon={<PackageIcon />}
          label={t('inventory.locations.allItems')}
          count={totalCount}
          onSelect={() => select(ALL_ITEMS_ID)}
          onFocus={() => setFocusedId(ALL_ITEMS_ID)}
        />
      );
    }
    const row = visibleRows[index - 1];
    return row ? renderNode(row) : null;
  }

  function renderNode({ node, level, posInSet, setSize }: VisibleTreeRow<LocationTreeNode>): ReactNode {
    const hasChildren = node.children.length > 0;
    const isExpanded = isOpen(node.id, level);
    // At the top level the synthetic "All items" row is a sibling, so it shifts every real
    // location one place along and widens the set by one.
    const atTopLevel = level === 1;
    return (
      <LocationTreeItem
        key={node.id}
        id={node.id}
        ref={setRowRef(node.id)}
        level={level}
        posInSet={atTopLevel ? posInSet + 1 : posInSet}
        setSize={atTopLevel ? topLevelSetSize : setSize}
        selected={selectedId === node.id}
        focused={focusedId === node.id}
        icon={<LocationKindIcon kind={node.kind} expanded={isExpanded && hasChildren} />}
        label={node.name}
        colorClass={locationColorTextClass(node.color)}
        description={node.description}
        count={node.itemCount}
        capacity={node.capacity}
        volumeFullness={volumeFullnessFor(node)}
        isDefault={node.isDefault}
        archived={node.archivedAt != null}
        expanded={hasChildren ? isExpanded : undefined}
        onToggle={hasChildren ? () => toggle(node.id, !isExpanded) : undefined}
        onSelect={() => select(node.id)}
        onFocus={() => setFocusedId(node.id)}
        editing={renamingId === node.id}
        onRename={(name) => commitRename(node.id, name)}
        onRenameCancel={() => endRename(node.id)}
        onEdit={node.isSystem ? undefined : () => setEditLocation(node)}
        editLabel={`Edit ${node.name}`}
        onPrintLabel={labelsEnabled ? () => setPrintLabelNode(node) : undefined}
        printLabelLabel={`Print label for ${node.name}`}
        onDropItem={
          node.archivedAt != null
            ? undefined
            : (itemId, itemName) => moveItemToLocation(itemId, itemName, node.id, node.name)
        }
        receivingItem={movingItemToId === node.id}
        // Drag-to-nest (spec §4): a non-system, non-archived location can be dragged onto
        // another such location to nest beneath it. System/archived rows are neither a valid
        // source nor a valid parent (mirroring the dialogs' `!isSystem` parent filter). While a
        // nest is in flight no row is draggable, so the user can't start stacking a second
        // re-parent on top of the first (see the `isPending` gate in `nestLocation`).
        draggable={!node.isSystem && node.archivedAt == null && !updateLocation.isPending}
        onDropLocation={
          node.isSystem || node.archivedAt != null
            ? undefined
            : (draggedId) => nestLocation(draggedId, node.id)
        }
        acceptsLocation={(draggedId) => canNest(draggedId, node.id)}
        nesting={nestingId === node.id}
      />
    );
  }
}
