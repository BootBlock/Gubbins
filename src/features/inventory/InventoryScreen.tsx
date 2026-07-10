import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { plural } from '@/lib/plural';
import { Button, Input, LiveRegion, Spinner, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  AddIcon,
  BuilderIcon,
  CategoryIcon,
  CloseIcon,
  CycleCountIcon,
  DataDensityIcon,
  DuplicateTabIcon,
  EditIcon,
  ExportIcon,
  ImportIcon,
  InfoIcon,
  MoreIcon,
  PackageIcon,
  PrintIcon,
  ScanIcon,
  SearchIcon,
  SelectIcon,
  VisualDensityIcon,
} from '@/components/icons';
import {
  InfoHint,
  Menu,
  MenuAction,
  MenuSeparator,
  PageContainer,
  PageHeader,
  SplitButton,
  Tooltip,
  useViewTransitionsEnabled,
  withViewTransition,
} from '@/components/foundry';
import { AuditDayDialog, CycleCountDialog } from '@/features/lifecycle';
import { ScannerOverlay } from '@/features/scanner/components/ScannerOverlay';
import { ExportWizard } from '@/features/export/ExportWizard';
import { ITEM_STATUS_FILTERS, type Item, type ItemStatusFilter } from '@/db/repositories';
import { useLayoutStore, type LayoutDensity } from '@/state/stores/useLayoutStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFeature } from '@/features/modules/useFeature';
import { SearchBuilderProvider, useSearchBuilder } from '@/features/search/SearchBuilderContext';
import { VisualBuilder } from '@/features/search/components/VisualBuilder';
import { astError, useAstSearch } from '@/features/search/queries';
import {
  useApplicableStatuses,
  useInventoryItems,
  useItemCount,
  useLocations,
  useLocationTree,
  type ItemQueryFilters,
} from './queries';
import { requestHighlight } from '@/lib/highlight';
import { useInventoryEntry } from './useInventoryEntry';
import { ItemDragProvider } from './item-drag';
import { GROUP_MODES } from './grouping';
import { LocationSidebar } from './components/LocationSidebar';
import { ItemList } from './components/ItemList';
import { GroupedItemList } from './components/GroupedItemList';
import { useCardFieldsConfig } from './components/useCardFieldsConfig';
import type { CardFieldsListContext } from './components/card-fields-render';
import { useItemFieldValues } from './categories';
import { locationColorTextClass } from './location-color';
import { defaultLocationForNewItem, markedDefaultLocationId } from './location-tree';
import { InventoryFilterBar } from './components/InventoryFilterBar';
import { InventoryFacetBar } from './components/InventoryFacetBar';
import { LocationInfoCard } from './components/LocationInfoCard';
import { CreateItemDialog } from './components/CreateItemDialog';
import { CategoryManagerDialog } from './components/CategoryManagerDialog';
import { PrintLabelsDialog } from './components/PrintLabelsDialog';
import { ImportDataDialog } from './components/ImportDataDialog';
import { BulkEditDialog } from './components/BulkEditDialog';
import { useCloneItem } from './mutations';
import type { ItemSelection } from './components/inventory-ui';
import type { LabelItem } from './labels/label-sheet';

/**
 * The "View" rows in the inventory "More" menu — the Data-Heavy ↔ Visual-Heavy
 * density axis (how each item is *drawn*; orthogonal to {@link GROUP_MODES}, which
 * governs how items are *arranged*). Only two fixed values, so unlike `GROUP_MODES`
 * this isn't designed to grow — kept as a plain local array rather than a shared SSOT.
 */
const DENSITY_MODES: ReadonlyArray<{ value: LayoutDensity; label: string; icon: typeof VisualDensityIcon }> =
  [
    { value: 'visual', label: 'Visual', icon: VisualDensityIcon },
    { value: 'data', label: 'Data', icon: DataDensityIcon },
  ];

/**
 * Help text for the "Show removed" toggle (rendered as rich Markdown in an {@link InfoHint}).
 * Explains that removing an item is a reversible soft-delete — it leaves active inventory but
 * keeps its history — and that the toggle brings those items back so they can be restored.
 */
const SHOW_REMOVED_HINT =
  `Items you **remove** aren't deleted — they leave your active inventory but keep their full ` +
  `history. Tick this to include those removed items in the list, so you can review or ` +
  `**restore** one. Leave it off to see only your active stock.`;

/**
 * The inventory workspace (spec §5): location sidebar, a search/filter header with
 * the Data-Heavy ↔ Visual-Heavy toggle, the Phase 5 **Visual Builder** panel for
 * complex graphical queries, and the virtualised item list. The ephemeral search
 * AST lives in a Tier-3 {@link SearchBuilderProvider} mounted with this screen.
 */
export function InventoryScreen() {
  return (
    <SearchBuilderProvider>
      <InventoryWorkspace />
    </SearchBuilderProvider>
  );
}

function InventoryWorkspace() {
  const density = useLayoutStore((s) => s.density);
  const setDensity = useLayoutStore((s) => s.setDensity);
  const grouping = useLayoutStore((s) => s.grouping);
  const setGrouping = useLayoutStore((s) => s.setGrouping);
  // The opt-out compact per-location summary card (device-local view preference).
  const showLocationCard = useLayoutStore((s) => s.inventoryLocationCard);
  const toggleLocationCard = useLayoutStore((s) => s.toggleInventoryLocationCard);
  // Live camera scanning is the `scanner` capability (modular-ui-plan §4, Phase 6): with it
  // off the Scan entry point disappears. Printed QR/Code-128 labels are unaffected — they
  // stay regardless — and manually reachable flows are untouched.
  const scannerEnabled = useFeature('scanner');
  // Label printing is its own module (Modular UI): with it off, the bulk "Print labels"
  // action and the per-location label action disappear. The underlying data is untouched.
  const labelsEnabled = useFeature('labels');
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  // The active §3/§4 "attention" status filters (low stock / expiring / overdue / maintenance
  // due). Additive to the location scope + search; OR-combined server-side. Session-local.
  const [statusFilters, setStatusFilters] = useState<ReadonlySet<ItemStatusFilter>>(
    () => new Set<ItemStatusFilter>(),
  );
  // Attribute facets (spec §3 filter axis): a single category plus a set of tags. Facets AND
  // with the status filters, the location scope and search. Session-local like the sidebar.
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<readonly string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  // A retail barcode scanned for an item that doesn't exist yet — seeds the add-item form
  // (recommendation point 1). Cleared when the dialog closes.
  const [scanBarcode, setScanBarcode] = useState<string | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [cycleCountOpen, setCycleCountOpen] = useState(false);
  // Guided multi-location stock-take / audit day (spec §4.4). Unlike the single-location
  // Cycle count above, this walks a chosen scope of locations in turn and is resumable, so
  // it needs no pre-selected location — the dialog owns its own scope picker and progress.
  const [auditDayOpen, setAuditDayOpen] = useState(false);
  // Multi-select for batch label printing (spec §6, Phase 49; templated Phase 73). The
  // selection captures each item's label fields (name/MPN/location/quantity) at toggle
  // time so it survives the bounded virtualised-list window (a selected item whose page
  // has been trimmed off still prints) and spans filter changes.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, LabelItem>>(new Map());
  const [printOpen, setPrintOpen] = useState(false);
  // Bulk edit (Phase 76) operates on the same multi-selection; duplicate clones one item.
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [actionAnnouncement, setActionAnnouncement] = useState('');
  const cloneItem = useCloneItem();

  const { ast, conditionCount } = useSearchBuilder();
  // The Visual Builder supersedes the quick search/location filters when it is open
  // and holds at least one valid condition (spec §5.1).
  const astActive = builderOpen && conditionCount > 0 && astError(ast) === null;
  // "By location" grouping arranges the standard filtered list into collapsible sections
  // (spec §3 grouping axis). The Visual Builder produces a flat AST result set that isn't
  // organised by location, so while it's active we fall back to the flat list regardless
  // of the chosen grouping — the two supersede in that order.
  const grouped = grouping === 'location' && !astActive;

  // Debounce the quick-search box so each keystroke doesn't hit the worker.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Consume a one-shot intent handed over from the dashboard (command palette "jump to
  // item", or the hero's Add/Scan quick actions): seed the search or open the relevant
  // dialog, then clear it. Driven off the store so it fires whether this screen is
  // mounting fresh from the navigation or is already on screen.
  const pendingSearch = useInventoryEntry((s) => s.pendingSearch);
  const pendingIntent = useInventoryEntry((s) => s.pendingIntent);
  const pendingLocationId = useInventoryEntry((s) => s.pendingLocationId);
  useEffect(() => {
    if (pendingSearch === null) return;
    setSearchInput(pendingSearch);
    setSearch(pendingSearch);
    useInventoryEntry.getState().clearSearch();
  }, [pendingSearch]);
  useEffect(() => {
    if (pendingIntent === null) return;
    if (pendingIntent === 'add') setAddOpen(true);
    else if (pendingIntent === 'scan') setScannerOpen(true);
    else if (pendingIntent === 'import') setImportOpen(true);
    useInventoryEntry.getState().clearIntent();
  }, [pendingIntent]);
  useEffect(() => {
    if (pendingLocationId === null) return;
    setSelectedLocationId(pendingLocationId);
    useInventoryEntry.getState().clearLocation();
  }, [pendingLocationId]);

  // The low-stock / expiring thresholds the status filters judge against are the same
  // user-tuned preferences the dashboard widgets and alert centre use (Phase 46), so the
  // "Low stock"/"Expiring" chips flag exactly what those surfaces do.
  const lowStockQtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const lowStockGaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);

  const toggleStatusFilter = useCallback((status: ItemStatusFilter) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);
  const clearStatusFilters = useCallback(() => setStatusFilters(new Set<ItemStatusFilter>()), []);

  const toggleTag = useCallback((tagId: string) => {
    setTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  }, []);

  // Emit the selected statuses in the canonical order so the query key is stable regardless
  // of the order chips were toggled (mirrors the server-side ordering in buildStatusFilter).
  const statusList = useMemo(
    () => ITEM_STATUS_FILTERS.filter((status) => statusFilters.has(status)),
    [statusFilters],
  );
  // Sort the tag ids too so the query key is stable regardless of the order chips were added.
  const tagIdList = useMemo(() => [...tagIds].sort(), [tagIds]);

  const filters: ItemQueryFilters = useMemo(
    () => ({
      ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(tagIdList.length > 0 ? { tagIds: tagIdList } : {}),
      ...(search ? { search } : {}),
      includeInactive,
      ...(statusList.length > 0
        ? {
            status: statusList,
            lowStockThresholds: {
              qtyThreshold: lowStockQtyThreshold,
              gaugePercent: lowStockGaugePercent,
            },
            expirySoonWindowDays,
          }
        : {}),
    }),
    [
      selectedLocationId,
      categoryId,
      tagIdList,
      search,
      includeInactive,
      statusList,
      lowStockQtyThreshold,
      lowStockGaugePercent,
      expirySoonWindowDays,
    ],
  );

  const tree = useLocationTree();
  const flat = useLocations();
  const totalCount = useItemCount({ includeInactive });
  const listItems = useInventoryItems(filters);
  const astItems = useAstSearch(ast, astActive);
  const active = astActive ? astItems : listItems;

  // "Show removed" reveals soft-deleted items (is_active = 0), so it only earns its place in the
  // header when the current view actually has removed items to reveal. Probe that by scoping to
  // what the list is showing — the selected location in the flat view, or everything in the
  // grouped view (which ignores the sidebar selection) — and comparing an all-items count with an
  // active-only one; their difference is the removed count, with no bespoke query needed.
  // keepPreviousData (inside useItemCount) stops the counts flickering the toggle on a location
  // change. In the no-location case these keys coincide with `totalCount` above and dedupe.
  const removedProbeScope = useMemo(
    () => (grouped || !selectedLocationId ? {} : { locationId: selectedLocationId }),
    [grouped, selectedLocationId],
  );
  const activeScopeCount = useItemCount({ ...removedProbeScope, includeInactive: false });
  const allScopeCount = useItemCount({ ...removedProbeScope, includeInactive: true });
  // Require both counts before judging, so the toggle never flashes in on first load when the
  // all-items count resolves a tick before the active-only one (keepPreviousData keeps them
  // resolved together across later location changes, so there is no flash then either).
  const hasRemovedInScope =
    activeScopeCount.isSuccess &&
    allScopeCount.isSuccess &&
    (allScopeCount.data ?? 0) > (activeScopeCount.data ?? 0);
  // Show the toggle when it can do something: removed items exist to reveal, or it's already on
  // (so the user can turn it back off). Never during a Visual-Builder search — that path is
  // always active-only, so the toggle would be inert.
  const showRemovedToggle = !astActive && (includeInactive || hasRemovedInScope);

  // How many items match each status filter **in the selected location** — recomputed on every
  // location change (the id keys the query). Drives both which chips the filter bar hides (the
  // `applicableStatuses` set) and the match count shown in each chip's label. Left undefined
  // until known so every enabled chip shows with no count until then (no empty flash). Gated
  // off while the Visual Builder drives the results (astActive): the status chips are
  // superseded and disabled then, so the round-trip couldn't change anything the user can do.
  const applicableStatusesQuery = useApplicableStatuses(selectedLocationId, !astActive);
  const statusCounts = useMemo(
    () =>
      applicableStatusesQuery.data
        ? new Map(applicableStatusesQuery.data.map((s) => [s.status, s.count]))
        : undefined,
    [applicableStatusesQuery.data],
  );
  const applicableStatuses = useMemo(
    () => (statusCounts ? new Set(statusCounts.keys()) : undefined),
    [statusCounts],
  );

  const locationNames = useMemo(() => {
    const map = new Map<string, string>();
    flat.data?.rows.forEach((loc) => map.set(loc.id, loc.name));
    return map;
  }, [flat.data]);
  const locationName = (id: string) => locationNames.get(id) ?? 'Unassigned';

  // The optional per-location colour tint (resolved to a Tailwind text class), so an
  // item row/card can render its location name in that location's chosen swatch.
  const locationColors = useMemo(() => {
    const map = new Map<string, string | null>();
    flat.data?.rows.forEach((loc) => map.set(loc.id, loc.color));
    return map;
  }, [flat.data]);
  const locationColorClass = (id: string) => locationColorTextClass(locationColors.get(id));

  const flatItems = useMemo(() => active.data?.pages.flatMap((p) => p.rows) ?? [], [active.data]);
  // Absolute index of the first resident item: non-zero once `maxPages` has trimmed
  // off the leading page(s), so the virtualised list can index in absolute space.
  const firstItemIndex = active.data?.pages[0]?.offset ?? 0;
  const flatLocations = flat.data?.rows ?? [];
  // The selected location's live row (with its item count), for the compact summary card.
  const selectedLocation = useMemo(
    () => (selectedLocationId ? (flat.data?.rows.find((l) => l.id === selectedLocationId) ?? null) : null),
    [flat.data, selectedLocationId],
  );

  // Configurable item-card fields (backlog E1): the shared order/catalog/category resolver,
  // plus — only when a custom field is actually shown — the stored custom-field values for the
  // resident window (so the virtualised cards render them without a per-card fetch).
  const cardFieldsConfig = useCardFieldsConfig();
  const residentItemIds = useMemo(() => flatItems.map((i) => i.id), [flatItems]);
  const cardFieldValues = useItemFieldValues(residentItemIds, cardFieldsConfig.hasCustomFields);
  const cardFields: CardFieldsListContext = { ...cardFieldsConfig, values: cardFieldValues.data };

  // Whether a status chip or a category/tag facet is currently narrowing the list. Used to
  // suppress the child-location drill-down (below) and to shape the empty banner's copy.
  const hasStatusOrFacetFilters = statusFilters.size > 0 || Boolean(categoryId) || tagIds.length > 0;

  // Child locations of the selected location, so a location that holds no items of its own
  // but nests others can offer them as a "drill down" grid instead of a dead-end empty state.
  // Suppressed while any query is narrowing the list — a text/visual query, a status chip or a
  // facet — so the child cards can't read as matches, and for the "All locations" view.
  const childLocations = useMemo(() => {
    if (!selectedLocationId || search || astActive || hasStatusOrFacetFilters) return [];
    return (flat.data?.rows ?? []).filter((loc) => loc.parentId === selectedLocationId && !loc.archivedAt);
  }, [flat.data, selectedLocationId, search, astActive, hasStatusOrFacetFilters]);

  // Pick the list's entrance so it reflects whichever input changed. A view-mode switch
  // (Visual ↔ Data) slides the list in horizontally, tracking the segmented control: Data
  // (the right segment) enters from the right, Visual (the left segment) from the left. A
  // location change keeps the quick vertical swap-in. We remount the list wrapper on either
  // change (via `listKey`) and compare the previous density to know which entrance to play.
  const prevDensity = useRef(density);
  const densityChanged = prevDensity.current !== density;
  useEffect(() => {
    prevDensity.current = density;
  }, [density]);
  // When view transitions are active the density restyle cross-fades the whole region
  // (the toggle routes through `withViewTransition` below), so the horizontal slide is
  // suppressed — the two would otherwise double-animate. Where transitions are unavailable
  // or motion is reduced, `vtEnabled` is false and the slide remains as the fallback.
  const vtEnabled = useViewTransitionsEnabled();
  const listEntrance = densityChanged
    ? vtEnabled
      ? ''
      : density === 'data'
        ? 'animate-slide-in-right'
        : 'animate-slide-in-left'
    : 'animate-swap-in';
  // Re-key (and so replay the entrance) when the *arrangement* changes: switching between
  // flat and grouped swaps the whole region. Grouped mode keeps a density-stable key so a
  // Data↔Visual restyle doesn't remount and lose the sections' expanded state, and it
  // ignores the sidebar selection (every location is shown as its own section).
  const listKey = grouped ? 'group-location' : `view-${density}-${selectedLocationId ?? 'all'}`;

  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  // Keep `onToggle`'s only external read (the location-name lookup) behind a ref so the
  // callback identity can stay stable — otherwise `selection` churns every render and
  // defeats the `memo` on every visible ItemRow/ItemCard.
  const locationNamesRef = useRef(locationNames);
  locationNamesRef.current = locationNames;
  const onToggleSelect = useCallback((item: Item) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else {
        next.set(item.id, {
          id: item.id,
          name: item.name,
          mpn: item.mpn,
          locationName: locationNamesRef.current.get(item.locationId) ?? 'Unassigned',
          quantity: item.quantity,
        });
      }
      return next;
    });
  }, []);
  // `selectedIds` is threaded to `ItemList` separately (below) rather than folded into
  // `selection`, so this object's identity survives a toggle — only its stable `onToggle`
  // member remains, keeping the `memo` on every visible ItemRow/ItemCard effective.
  const selection: ItemSelection | undefined = useMemo(
    () => (selecting ? { onToggle: onToggleSelect } : undefined),
    [selecting, onToggleSelect],
  );
  const selectedLabels = useMemo(() => Array.from(selected.values()), [selected]);
  const selectedItemIds = useMemo(() => Array.from(selected.keys()), [selected]);
  const toggleSelecting = () => {
    setSelecting((on) => {
      if (on) setSelected(new Map()); // leaving select mode clears the selection
      return !on;
    });
  };

  // Duplicate the single selected item (enabled only when exactly one is selected). The clone
  // appears in the list on invalidation; the selection is cleared and the outcome announced.
  const duplicateSelected = async () => {
    const sourceId = selectedItemIds[0];
    if (selected.size !== 1 || !sourceId) return;
    try {
      await cloneItem.mutateAsync({ sourceId });
      setSelected(new Map());
      setActionAnnouncement('Item duplicated — the copy has been added to the inventory.');
    } catch {
      setActionAnnouncement('Could not duplicate the item.');
    }
  };

  return (
    <PageContainer fullHeight>
      <PageHeader
        className="pb-4"
        hideSearch
        icon={<PackageIcon />}
        title="Inventory"
        actions={
          <>
            {/* `min-w`/`max-w` + `flex-1` (rather than a fixed `w-64`) let the box cooperate
                with the row's flex-wrap: it shrinks under space pressure and grows to fill
                slack, instead of forcing an early hard break — the same fix applied to the
                dashboard hero's search box, and for the same reason. The row itself now holds
                only Search/Add item/Scan/More, mirroring the dashboard hero's Search/Add/
                Scan/Menu set — Visual search, the view density and the grouping mode all
                moved into the "More" menu below so the row stays this simple. */}
            <div className="relative min-w-[10rem] max-w-xs flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  // Escape clears the box (standard search-field behaviour), keeping focus.
                  if (e.key === 'Escape' && searchInput) {
                    e.preventDefault();
                    setSearchInput('');
                  }
                }}
                placeholder="Search items…"
                className={`pl-9 ${searchInput ? 'pr-9' : ''}`}
                aria-label="Search items"
                disabled={astActive}
              />
              {searchInput && !astActive ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    searchRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  data-testid="inventory-search-clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>

            {/* Add item is a split button: the primary half opens the create dialog, and the
                attached chevron offers Import… (the same entry point the dashboard hero uses).
                Import lives here rather than in the "More" menu so there is one obvious place
                to bring items in — beside the button that adds them. Placed right after search
                (mirroring the dashboard hero's Search → Add item → Scan order) so the primary
                actions stay grouped together at the front of the row; if the row must wrap at
                a narrow width, it's the less-common view controls below that give way first. */}
            <SplitButton
              menuLabel="More add-item actions"
              triggerProps={{ 'data-testid': 'inventory-add-menu' }}
              primary={
                <Button onClick={() => setAddOpen(true)} data-testid="inventory-add-item">
                  <AddIcon />
                  Add item
                </Button>
              }
            >
              <MenuAction
                icon={<ImportIcon />}
                onSelect={() => setImportOpen(true)}
                data-testid="open-catalog-import"
              >
                Import…
              </MenuAction>
            </SplitButton>

            {scannerEnabled ? (
              <Button variant="outline" onClick={() => setScannerOpen(true)}>
                <ScanIcon />
                Scan
              </Button>
            ) : null}

            <Menu
              label="More inventory actions"
              trigger={
                <>
                  <MoreIcon />
                  More
                </>
              }
            >
              {/* Build complex queries graphically — combine fields, capabilities and AND/OR
                  groups. Supersedes the quick search while active. */}
              <MenuAction
                icon={<BuilderIcon />}
                onSelect={() => setBuilderOpen((v) => !v)}
                selected={builderOpen}
              >
                Visual search
              </MenuAction>
              <MenuSeparator />
              {/* View (the Data-Heavy ↔ Visual-Heavy density axis — how each item is *drawn*)
                  and Group by (how the list is *arranged*) sit together as the two arrangement
                  axes, each rendered off its own SSOT so a future mode needs no menu rework. */}
              {DENSITY_MODES.map((mode) => (
                <MenuAction
                  key={mode.value}
                  icon={<mode.icon />}
                  onSelect={() => withViewTransition(() => setDensity(mode.value))}
                  selected={density === mode.value}
                >
                  View: {mode.label}
                </MenuAction>
              ))}
              {GROUP_MODES.map((mode) => (
                <MenuAction
                  key={mode.value}
                  onSelect={() => setGrouping(mode.value)}
                  selected={grouping === mode.value}
                >
                  Group by: {mode.label}
                </MenuAction>
              ))}
              <MenuSeparator />
              <MenuAction
                icon={<InfoIcon />}
                onSelect={toggleLocationCard}
                selected={showLocationCard}
                data-testid="toggle-location-info"
              >
                Location summary
              </MenuAction>
              <MenuSeparator />
              <MenuAction icon={<CategoryIcon />} onSelect={() => setCategoriesOpen(true)}>
                Categories
              </MenuAction>
              <MenuAction
                icon={<CycleCountIcon />}
                onSelect={() => setCycleCountOpen(true)}
                disabled={!selectedLocationId}
                data-testid="open-cycle-count"
              >
                {selectedLocationId ? 'Cycle count' : 'Cycle count — select a location'}
              </MenuAction>
              <MenuAction
                icon={<CycleCountIcon />}
                onSelect={() => setAuditDayOpen(true)}
                data-testid="open-audit-day"
              >
                Stock-take (audit day)…
              </MenuAction>
              <MenuSeparator />
              <MenuAction icon={<ExportIcon />} onSelect={() => setExportOpen(true)}>
                Export
              </MenuAction>
              <MenuSeparator />
              <MenuAction
                icon={<SelectIcon />}
                onSelect={toggleSelecting}
                selected={selecting}
                data-testid="toggle-select"
              >
                Select items
              </MenuAction>
            </Menu>
          </>
        }
      />

      {/* Visual-search reveal: the panel stays mounted and animates open/closed both ways
          by transitioning a collapsing CSS grid row (0fr ↔ 1fr) plus opacity over 1s with
          the signature emphasized ease. `inert` when closed keeps the hidden panel out of
          the tab order and the accessibility tree. Reduced-motion users skip the transition
          via the global catch-all and simply get the end state. */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-1000 ease-emphasized"
        style={{ gridTemplateRows: builderOpen ? '1fr' : '0fr', opacity: builderOpen ? 1 : 0 }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pb-4" inert={!builderOpen}>
            <VisualBuilder
              resultSummary={
                astActive ? `${flatItems.length} ${plural(flatItems.length, 'match', 'matches')}` : undefined
              }
            />
          </div>
        </div>
      </div>

      {/* Drag-to-move (spec §4): the provider owns the unified pointer drag and must wrap both
          the drop targets (the sidebar) and the drag sources (the item list). */}
      <ItemDragProvider>
        <div className="flex min-h-0 flex-1 gap-6 large-format:gap-8">
          {tree.data && flat.data ? (
            <LocationSidebar
              tree={tree.data}
              flat={flatLocations}
              selectedId={selectedLocationId}
              onSelect={setSelectedLocationId}
              totalCount={totalCount.data ?? 0}
            />
          ) : (
            <div className="w-64 shrink-0 large-format:w-72" />
          )}

          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            className="flex min-w-0 flex-1 animate-rise flex-col overflow-x-clip outline-none"
          >
            {/* Compact summary of the selected location (fullness, path, last change, …).
                Opt-out and device-local; hidden for the "All locations" view. It stays
                mounted while a location is selected and animates open/closed both ways by
                transitioning a collapsing CSS grid row (0fr ↔ 1fr) plus opacity with the
                signature emphasized ease — mirroring the visual-search reveal below. `inert`
                when hidden keeps it out of the tab order and accessibility tree; reduced-motion
                users skip the transition via the global catch-all and get the end state. */}
            {selectedLocation ? (
              <div
                className="grid transition-[grid-template-rows,opacity] duration-300 ease-emphasized"
                style={{
                  gridTemplateRows: showLocationCard ? '1fr' : '0fr',
                  opacity: showLocationCard ? 1 : 0,
                }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div inert={!showLocationCard}>
                    <LocationInfoCard
                      location={selectedLocation}
                      locations={flatLocations}
                      onHide={toggleLocationCard}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <InventoryFilterBar
              value={statusFilters}
              onToggle={toggleStatusFilter}
              onClear={clearStatusFilters}
              applicable={applicableStatuses}
              counts={statusCounts}
              disabled={astActive}
            />

            <InventoryFacetBar
              categoryId={categoryId}
              onCategoryChange={setCategoryId}
              tagIds={tagIds}
              onToggleTag={toggleTag}
              disabled={astActive}
            />

            <div className="flex items-center justify-between pb-3">
              <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                {grouped
                  ? 'Grouped by location'
                  : active.isSuccess
                    ? `${flatItems.length} shown${astActive ? ' (visual search)' : ''}`
                    : 'Loading…'}
              </p>
              {/* Only shown when it applies (removed items exist in view, or it's already on) —
                  see `showRemovedToggle`. The help badge sits outside the label so a tap on the
                  hint doesn't toggle the checkbox. */}
              {showRemovedToggle ? (
                <div className="flex items-center gap-1.5">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={includeInactive}
                      onChange={(e) => setIncludeInactive(e.target.checked)}
                      className="size-3.5 accent-primary"
                    />
                    Show removed
                  </label>
                  <InfoHint content={SHOW_REMOVED_HINT} />
                </div>
              ) : null}
            </div>

            {selecting ? (
              <div
                className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
                data-testid="selection-bar"
              >
                <span className="text-sm font-medium" data-testid="selection-count">
                  {selected.size} selected
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(new Map())}
                    disabled={selected.size === 0}
                  >
                    Clear
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkEditOpen(true)}
                    disabled={selected.size === 0}
                    data-testid="bulk-edit"
                  >
                    <EditIcon />
                    Bulk edit
                  </Button>
                  <Tooltip
                    content="Seed a new item from this one (item-as-template). Select exactly one item."
                    triggerTabIndex={-1}
                  >
                    <span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={duplicateSelected}
                        disabled={selected.size !== 1 || cloneItem.isPending}
                        data-testid="duplicate-item"
                      >
                        <DuplicateTabIcon />
                        {cloneItem.isPending ? 'Duplicating…' : 'Duplicate'}
                      </Button>
                    </span>
                  </Tooltip>
                  {labelsEnabled ? (
                    <Button
                      size="sm"
                      onClick={() => setPrintOpen(true)}
                      disabled={selected.size === 0}
                      data-testid="print-labels"
                    >
                      <PrintIcon />
                      Print labels
                    </Button>
                  ) : null}
                  <Tooltip content="Leave select mode and clear the current selection." triggerTabIndex={-1}>
                    <span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={toggleSelecting}
                        aria-label="Done selecting"
                      >
                        <CloseIcon />
                      </Button>
                    </span>
                  </Tooltip>
                </div>
              </div>
            ) : null}

            {/* Keyed by the selected location *and* the density so switching either re-mounts
              this region and replays an entrance — the list visibly arrives rather than
              blinking into place. A location change plays the quick vertical swap-in; a
              view-mode change plays the horizontal slide chosen in `listEntrance`.
              (Search-as-you-type deliberately doesn't re-key, so typing never flashes the
              list.) Reduced-motion is handled by the global catch-all. */}
            <div key={listKey} className={cn('flex min-h-0 flex-1 flex-col', listEntrance)}>
              {grouped ? (
                tree.data ? (
                  <GroupedItemList
                    tree={tree.data}
                    density={density}
                    search={search}
                    includeInactive={includeInactive}
                    categoryId={filters.categoryId}
                    tagIds={filters.tagIds}
                    status={filters.status}
                    lowStockThresholds={filters.lowStockThresholds}
                    expirySoonWindowDays={filters.expirySoonWindowDays}
                    locations={flatLocations}
                    locationName={locationName}
                    locationColorClass={locationColorClass}
                    selection={selection}
                    selectedIds={selectedIds}
                    cardFieldsConfig={cardFieldsConfig}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <Spinner />
                  </div>
                )
              ) : active.isLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <ItemList
                  items={flatItems}
                  firstItemIndex={firstItemIndex}
                  locations={flatLocations}
                  density={density}
                  selectedLocationId={selectedLocationId}
                  locationName={locationName}
                  locationColorClass={locationColorClass}
                  hasNextPage={active.hasNextPage}
                  isFetchingNextPage={active.isFetchingNextPage}
                  fetchNextPage={() => void active.fetchNextPage()}
                  hasPreviousPage={active.hasPreviousPage}
                  isFetchingPreviousPage={active.isFetchingPreviousPage}
                  fetchPreviousPage={() => void active.fetchPreviousPage()}
                  childLocations={childLocations}
                  onSelectLocation={setSelectedLocationId}
                  selection={selection}
                  selectedIds={selectedIds}
                  cardFields={cardFields}
                  emptyContext={
                    astActive
                      ? { visualSearch: true }
                      : {
                          search,
                          statusFilterCount: statusFilters.size,
                          categoryFilter: Boolean(categoryId),
                          tagFilterCount: tagIds.length,
                        }
                  }
                />
              )}
            </div>
          </main>
        </div>
      </ItemDragProvider>

      {/* Mounted only while open so the location default is re-seeded from the current
          sidebar selection on every open — a real, user-created location pre-fills the
          dialog's Location (the form captures `defaultLocationId` on mount). Mirrors the
          "Add location" dialog in LocationSidebar. */}
      {addOpen ? (
        <CreateItemDialog
          open
          onClose={() => {
            setAddOpen(false);
            setScanBarcode(null);
          }}
          locations={flatLocations}
          defaultLocationId={defaultLocationForNewItem(
            selectedLocationId,
            flatLocations,
            markedDefaultLocationId(flatLocations),
          )}
          initialValues={scanBarcode ? { barcode: scanBarcode } : undefined}
        />
      ) : null}
      <CategoryManagerDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      {cycleCountOpen && selectedLocationId ? (
        <CycleCountDialog
          open
          onClose={() => setCycleCountOpen(false)}
          location={{ id: selectedLocationId, name: locationName(selectedLocationId) }}
        />
      ) : null}
      <AuditDayDialog open={auditDayOpen} onClose={() => setAuditDayOpen(false)} />
      <ScannerOverlay
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onLocationScanned={(id) => {
          setSelectedLocationId(id);
          setScannerOpen(false);
        }}
        onCreateFromBarcode={(gtin) => {
          setScannerOpen(false);
          setScanBarcode(gtin);
          setAddOpen(true);
        }}
        onViewItem={(item) => {
          // Jump-to-item, mirroring the command palette / alert deep-links: seed the search so
          // the item is in view even if a filter would hide it, then flash its card.
          setScannerOpen(false);
          useInventoryEntry.getState().requestSearch(item.name);
          requestHighlight(item.id);
        }}
      />
      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />
      <ImportDataDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <PrintLabelsDialog open={printOpen} onClose={() => setPrintOpen(false)} items={selectedLabels} />
      <BulkEditDialog
        open={bulkEditOpen}
        onClose={() => setBulkEditOpen(false)}
        itemIds={selectedItemIds}
        locations={flatLocations}
        onApplied={(message) => {
          setSelected(new Map());
          setActionAnnouncement(message);
        }}
      />

      {/* Announce bulk-edit / duplicate outcomes (WCAG 4.1.3). */}
      <LiveRegion visuallyHidden data-testid="inventory-action-live-region">
        {actionAnnouncement ? <p>{actionAnnouncement}</p> : null}
      </LiveRegion>
    </PageContainer>
  );
}
