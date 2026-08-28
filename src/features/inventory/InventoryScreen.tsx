import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  Button,
  CloseButton,
  Drawer,
  Input,
  LiveRegion,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  useCompactLayout,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import {
  AddIcon,
  BuilderIcon,
  CategoryIcon,
  CloseIcon,
  CatalogueIcon,
  CycleCountIcon,
  DataDensityIcon,
  DuplicateTabIcon,
  EditIcon,
  ExitFullscreenIcon,
  ExportIcon,
  FullscreenIcon,
  GroupByIcon,
  ImportIcon,
  InfoIcon,
  LocationTreeIcon,
  MoreIcon,
  PackageIcon,
  PrintIcon,
  SavedSearchIcon,
  ScanIcon,
  SearchIcon,
  SelectIcon,
  SortAscIcon,
  SortDescIcon,
  SortIcon,
  TagIcon,
} from '@/components/icons';
import {
  Checkbox,
  InfoHint,
  Menu,
  MenuAction,
  MenuSeparator,
  MenuSub,
  PageContainer,
  PageHeader,
  Tooltip,
  useViewTransitionsEnabled,
  withViewTransition,
} from '@/components/foundry';
import { AuditDayDialog } from '@/features/lifecycle/components/AuditDayDialog';
import { CycleCountDialog } from '@/features/lifecycle/components/CycleCountDialog';
import { ScannerOverlay } from '@/features/scanner/components/ScannerOverlay';
import type { ProductLookupResultPayload } from '@/features/scraping';
import { ExportWizard } from '@/features/export/ExportWizard';
import type { Item, ItemStatusFilter } from '@/db/repositories';
import { SORT_DIRECTIONS, useLayoutStore, type InventorySort } from '@/state/stores/useLayoutStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFeature } from '@/features/modules/useFeature';
import { usePermission } from '@/features/users/usePermission';
import { useT } from '@/features/i18n';
import { SearchBuilderProvider, useSearchBuilder } from '@/features/search/SearchBuilderContext';
import { VisualBuilder } from '@/features/search/components/VisualBuilder';
import { SavedSearchMenu } from '@/features/search/components/SavedSearchMenu';
import { planSavedSearchRecall } from '@/features/search/saved-searches';
import { astError, astLocationScope, useAstCount, useAstSearch } from '@/features/search/queries';
import {
  useApplicableStatuses,
  useInventoryItems,
  useItem,
  useItemCount,
  useItemPage,
  useLocations,
  useLocationTree,
  type ItemQueryFilters,
} from './queries';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { requestHighlight } from '@/lib/highlight';
import { useFullscreen } from '@/lib/useFullscreen';
import { useHotkeyScope } from '@/features/hotkeys/useHotkeyScope';
import { useInventoryEntry } from './useInventoryEntry';
import { useInventoryView } from './useInventoryView';
import { ItemDragProvider } from './item-drag';
import { DENSITY_MODES } from './view-modes';
import { GROUP_MODES } from './grouping';
import { SORT_MODES, initialDirection, sortMode, toItemSort } from './sorting';
import { LocationSidebar } from './components/LocationSidebar';
import { ItemList } from './components/ItemList';
import { GroupedItemList } from './components/GroupedItemList';
import { LocationMapView } from './components/LocationMapView';
import { ValueTreemapView } from './components/ValueTreemapView';
import { useCardFieldsConfig } from './components/useCardFieldsConfig';
import type { CardFieldsListContext } from './components/card-fields-render';
import { useItemFieldValues } from './categories';
import { useItemsTags } from './tags';
import { locationColorTextClass, locationColorTintClass } from './location-color';
import { defaultLocationForNewItem, findTreeNode, markedDefaultLocationId } from './location-tree';
import { InventoryFilterBar } from './components/InventoryFilterBar';
import { InventoryFacetBar } from './components/InventoryFacetBar';
import { LocationInfoCard } from './components/LocationInfoCard';
import { LocationDetailCard } from './components/LocationDetailCard';
import { CreateItemDialog } from './components/CreateItemDialog';
import { CategoryManagerDialog } from './components/CategoryManagerDialog';
import { PrintLabelsDialog } from './components/PrintLabelsDialog';
import { ImportDataDialog } from './components/ImportDataDialog';
import { ItemDetailDialog } from './components/ItemDetailDialog';
import { BulkEditDialog } from './components/BulkEditDialog';
import { useCloneItem } from './mutations';
import { useUndoToast } from './useUndoToast';
import { useCatalogueLaunch } from '@/features/reports/useCatalogueLaunch';
import type { ItemSelection } from './components/inventory-ui';
import type { LabelItem } from './labels/label-sheet';

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
 * The inventory workspace (spec §5): location sidebar, a search/filter header whose
 * **More** menu carries the Card / Data / Table view modes, the Phase 5 **Visual Builder**
 * panel for complex graphical queries, and the virtualised item list. The ephemeral search
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
  const t = useT();
  const density = useLayoutStore((s) => s.density);
  const setDensity = useLayoutStore((s) => s.setDensity);
  const grouping = useLayoutStore((s) => s.grouping);
  const setGrouping = useLayoutStore((s) => s.setGrouping);
  // The ordering axis (issue #128) — which field the list is sorted by, and which way.
  const inventorySort = useLayoutStore((s) => s.inventorySort);
  const setInventorySort = useLayoutStore((s) => s.setInventorySort);
  // The current View / Group-by / Sort choices, so each submenu trigger names and glyphs its
  // active mode.
  const activeDensity = DENSITY_MODES.find((m) => m.value === density) ?? DENSITY_MODES[0]!;
  const activeGrouping = GROUP_MODES.find((m) => m.value === grouping) ?? GROUP_MODES[0]!;
  const activeSort = sortMode(inventorySort.field);
  // Null under the default order, which has no user-facing direction to offer — hoisted so the
  // menu's direction pair narrows on one check rather than per label lookup.
  const sortDirections = activeSort.directions;
  // The opt-out compact per-location summary card (device-local view preference).
  const showLocationCard = useLayoutStore((s) => s.inventoryLocationCard);
  const toggleLocationCard = useLayoutStore((s) => s.toggleInventoryLocationCard);
  // List pagination (issue #20) — an app-wide view preference. When on (and the flat list is
  // showing), the list splits into fixed-size pages with a control at the foot instead of the
  // default infinite scroll. The default page size is shared with Settings and editable inline.
  const paginateLists = usePreferencesStore((s) => s.paginateLists);
  const setPaginateLists = usePreferencesStore((s) => s.setPaginateLists);
  // Browser fullscreen toggle (issue #118) — stretches the app across the whole display for a
  // distraction-free, data-dense view. `supported` guards browsers without the Fullscreen API.
  const { supported: fullscreenSupported, isFullscreen, toggle: toggleFullscreen } = useFullscreen();
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  // Every axis this screen filters on — the location scope, the quick search, the attention
  // chips, the category/tag facets, "Show removed" and the page — is the `/inventory` URL
  // (issue #574). So Back undoes the last narrowing, a reload or a PWA update lands on the list
  // the user was reading, and a filtered view can be bookmarked or sent to someone. (A *fresh*
  // navigation to `/inventory` — the nav bar, the hotkey — carries no search params and so still
  // opens the plain list, which is what a link to a screen ought to mean.) The screen keeps no
  // filter state of its own; `useInventoryView` decodes the URL and its setters navigate.
  const { view, setView } = useInventoryView();
  const page = view.page;
  const setPage = useCallback(
    (next: number, options?: { readonly replace?: boolean }) => setView({ page: next }, options),
    [setView],
  );
  // Live camera scanning is the `scanner` capability (modular-ui-plan §4, Phase 6): with it
  // off the Scan entry point disappears. Printed QR/Code-128 labels are unaffected — they
  // stay regardless — and manually reachable flows are untouched.
  const scannerEnabled = useFeature('scanner');
  // Label printing is its own module (Modular UI): with it off, the bulk "Print labels"
  // action and the per-location label action disappear. The underlying data is untouched.
  const labelsEnabled = useFeature('labels');
  // The printable parts catalogue lives under the Reports module; with it off, the selection-bar
  // "Print catalogue" shortcut disappears (the catalogue screen itself is route-guarded too).
  const reportsEnabled = useFeature('reports');
  // Stock-taking is the `cycle-counts` capability (Modular UI): with it off, both entry points
  // in this menu — the single-location Cycle count and the guided audit day — disappear, along
  // with the "Last counted" stat on the location card. Counts already authorised are untouched.
  const cycleCountsEnabled = useFeature('cycle-counts');
  // The permission gate (issue #429). Each of these covers a *bulk* act over data the session can
  // already read one row at a time — pulling the whole vault into a spreadsheet, writing over a
  // hundred items at once, spending a roll of label stock — which is why they are grantable
  // separately from `items:read`, and why this screen, the app's densest collection of them, has
  // to ask. A refused capability takes its entry point off screen entirely rather than disabling
  // it: a greyed-out button still advertises a door the gate will not open. The handlers behind
  // them are guarded too, because select mode, the intent store and the dashboard's quick actions
  // can each reach a control the pointer can no longer see.
  const mayWriteItems = usePermission('items:write');
  const mayImport = usePermission('import:run');
  const mayExport = usePermission('export:run');
  const mayPrintLabels = usePermission('labels:print');
  const mayReadReports = usePermission('reports:read');
  const navigate = useNavigate();
  const selectedLocationId = view.locationId;
  const setSelectedLocationId = useCallback((id: string | null) => setView({ locationId: id }), [setView]);
  // Compact viewport (issue #147): below the tablet floor the fixed 256px location pane would
  // eat two thirds of a phone's width, so it moves into an off-canvas drawer opened from a
  // trigger above the list. A structural swap, not a style — the pane can only exist once
  // (one heading id, one roving-tabindex tree, one virtualiser), so it is a hook, not a variant.
  const compact = useCompactLayout();
  const [locationsDrawerOpen, setLocationsDrawerOpen] = useState(false);
  // Widening back past the breakpoint puts the pane back on screen; leaving the drawer flagged
  // open would spring it over the content the next time the viewport narrows.
  useEffect(() => {
    if (!compact) setLocationsDrawerOpen(false);
  }, [compact]);
  // The box's own text is local so typing stays instant; the debounced result below is what
  // reaches the URL (and therefore the query).
  const [searchInput, setSearchInput] = useState(view.search);
  const searchRef = useRef<HTMLInputElement>(null);
  const search = view.search;
  // Saved searches, surfaced on the quick-search box itself rather than only two levels down
  // inside the Visual search panel (issue #136). The strip below the header holds the same
  // save/recall/forget controls the power box has, revealed by the bookmark toggle in the box.
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const savedSearchesId = useId();
  const includeInactive = view.includeInactive;
  const setIncludeInactive = useCallback((on: boolean) => setView({ includeInactive: on }), [setView]);
  // The active §3/§4 "attention" status filters (low stock / expiring / overdue / maintenance
  // due). Additive to the location scope + search; OR-combined server-side. The URL holds them;
  // the set is only the membership lookup the filter bar's chips want.
  const statusFilters = useMemo<ReadonlySet<ItemStatusFilter>>(() => new Set(view.statuses), [view.statuses]);
  // Attribute facets (spec §3 filter axis): a single category plus a set of tags. Facets AND
  // with the status filters, the location scope and search.
  const categoryId = view.categoryId;
  const setCategoryId = useCallback((id: string | null) => setView({ categoryId: id }), [setView]);
  const tagIds = view.tagIds;
  const [addOpen, setAddOpen] = useState(false);
  // A retail barcode scanned for an item that doesn't exist yet — seeds the add-item form
  // (recommendation point 1). Cleared when the dialog closes.
  const [scanBarcode, setScanBarcode] = useState<string | null>(null);
  // A product the scanner resolved for that barcode via a lookup (issue #59): pre-fills the
  // add-item form's name/brand/description alongside the barcode. Cleared with the dialog.
  const [scanProduct, setScanProduct] = useState<ProductLookupResultPayload | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Standalone item-detail dialog opened by a deep link (a Reports data-hygiene row's jump-to-fix
  // link), keyed by item id; the item itself is fetched by `useItem` below. Distinct from the
  // per-row detail dialog inside `ItemActions` — this one has no row to hang off.
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
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
  // Confirms a reversible write and offers to put it back (issue #131).
  const undoToast = useUndoToast();
  const cloneItem = useCloneItem();

  const { ast, conditionCount, dispatch: builderDispatch } = useSearchBuilder();
  // The Visual Builder supersedes the quick search and the status/category/tag filters when
  // it is open and holds at least one valid condition (spec §5.1). The sidebar's location is
  // the exception — it scopes the search rather than being superseded by it (issue #626).
  const astActive = builderOpen && conditionCount > 0 && astError(ast) === null;
  // The sidebar's selected location scopes a Visual-Builder search exactly as it scopes the
  // plain list (issue #626) — otherwise "Garage" stays highlighted, its info card stays on
  // screen, and the rows underneath come from every other room. `null` once the tree names
  // `location` itself, because the user's own condition then says where to look.
  const astLocationId = astLocationScope(ast, selectedLocationId);

  // "By location" grouping arranges the standard filtered list into collapsible sections
  // (spec §3 grouping axis). The Visual Builder produces a flat AST result set that isn't
  // organised by location, so while it's active we fall back to the flat list regardless
  // of the chosen grouping — the two supersede in that order.
  const grouped = grouping === 'location' && !astActive;
  // The two whole-collection visualisations (Location map / Value treemap) replace the item list
  // entirely and stand on their own aggregations, so the per-item filter/facet bars, the "shown"
  // count and select mode don't apply — they're hidden while a visualisation is on screen.
  const isVizMode = density === 'map' || density === 'treemap';
  // Pagination replaces the standard flat Card/Data/Table list only — never the grouped view, the
  // whole-collection visualisations, or a Visual-Builder result set (each is its own presentation).
  const paginated = paginateLists && !grouped && !isVizMode && !astActive;

  // Debounce the quick-search box so each keystroke doesn't hit the worker, then commit the
  // settled query into the URL.
  //
  // **Starting** a search is one narrowing and pushes, so Back returns to the list as it was
  // before it. **Refining** or clearing one replaces, so typing "resistor" leaves a single entry
  // rather than eight, and Back from it does not walk back through the word a letter at a time.
  // The test is what the URL held a moment ago, not what is being typed now.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === search) return;
    const refining = search !== '';
    const timer = setTimeout(() => setView({ search: trimmed }, { replace: refining }), 250);
    return () => clearTimeout(timer);
  }, [searchInput, search, setView]);
  // Adopt a query that arrived from outside the box — a Back press, a deep link, a saved search
  // recalled into it. Compared trimmed so a half-typed "drill " isn't yanked back mid-word by
  // the very commit it just made.
  useEffect(() => {
    setSearchInput((current) => (current.trim() === search ? current : search));
  }, [search]);

  // Recall a saved search from the quick-search box (issue #136). A saved query made only of
  // bare words means exactly what it would mean typed here, so it simply fills this box; one
  // that carries syntax the quick box can't express (`cap:voltage>3.3`, an OR group, a negation)
  // loads into the Visual Builder and reveals that panel. Either way the *other* surface stands
  // aside, so exactly one query drives the results — the same supersede rule the panel already
  // follows. A query that no longer parses changes nothing and says so.
  const recallSavedSearch = useCallback(
    (query: string) => {
      const plan = planSavedSearchRecall(query);
      if (plan.kind === 'error') {
        setActionAnnouncement(t('inventory.savedSearches.failed', { vars: { reason: plan.error } }));
        return;
      }
      if (plan.kind === 'text') {
        setBuilderOpen(false);
        setSearchInput(plan.text);
        setActionAnnouncement(t('inventory.savedSearches.recalled'));
        return;
      }
      setSearchInput('');
      builderDispatch({ type: 'load', ast: plan.ast });
      setBuilderOpen(true);
      setActionAnnouncement(t('inventory.savedSearches.recalledBuilder'));
    },
    [builderDispatch, t],
  );

  // Consume a one-shot intent handed over from elsewhere (the dashboard hero's Add/Scan quick
  // actions, the Getting-started panel, a hotkey): open the relevant dialog, then clear it. Driven off
  // the store so it fires whether this screen is mounting fresh from the navigation or is already
  // on screen. The *view* axes a caller used to hand over the same way — a search to seed, a
  // location to scope to — are URL search params now (issue #574), so those callers simply link
  // to `/inventory?q=…` and need nothing from this store.
  const pendingIntent = useInventoryEntry((s) => s.pendingIntent);
  const pendingOpenItemId = useInventoryEntry((s) => s.pendingOpenItemId);
  useEffect(() => {
    if (pendingIntent === null) return;
    if (pendingIntent === 'add') setAddOpen(true);
    // The `scan` intent is a store handoff any caller can raise (the dashboard hero, the
    // Getting-started panel, a hotkey), so the capability is checked here as well as at each
    // entry point — otherwise one unguarded caller reopens the camera for a user who switched
    // live scanning off (issue #636). Refused intents are still cleared below.
    else if (pendingIntent === 'scan' && scannerEnabled) setScannerOpen(true);
    // An import intent is raised elsewhere (the dashboard hero, the command palette) and consumed
    // here, so it is a second route to the very dialog the menu no longer offers. Refusing it here
    // is what stops a hidden control from staying drivable; the intent is still cleared either
    // way, or it would re-fire on the next visit to this screen.
    else if (pendingIntent === 'import' && mayImport) setImportOpen(true);
    useInventoryEntry.getState().clearIntent();
  }, [pendingIntent, mayImport, scannerEnabled]);

  // The contextual shortcuts (issue #127): on this screen `N` adds an item and `/` jumps to the
  // quick-search box. Both reuse the very controls the buttons drive, so the keyboard route and
  // the pointer route can't drift apart.
  useHotkeyScope({
    onNew: useCallback(() => setAddOpen(true), []),
    onSearch: useCallback(() => searchRef.current?.focus(), []),
  });
  // Deep-link to one item's detail card (e.g. a Reports data-hygiene row): remember the id so
  // the standalone dialog below can fetch and open it. This one stays a store handoff rather
  // than a search param: the dialog it opens already claims a history entry of its own, so a
  // second one in the URL would need two Back presses to undo a single open (see
  // `foundry/dialog-history.ts`). The call site pairs it with `?q=<name>` so the item is also
  // in the list behind the dialog once it is closed.
  useEffect(() => {
    if (pendingOpenItemId === null) return;
    setDetailItemId(pendingOpenItemId);
    useInventoryEntry.getState().clearOpenItem();
  }, [pendingOpenItemId]);
  // Full record for the deep-linked detail dialog; the query is disabled until an id is set.
  const detailItem = useItem(detailItemId ?? undefined);

  // The low-stock / expiring thresholds the status filters judge against are the same
  // user-tuned preferences the dashboard widgets and alert centre use (Phase 46), so the
  // "Low stock"/"Expiring" chips flag exactly what those surfaces do.
  const lowStockQtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const lowStockGaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);

  // Both toggles take the functional form so the callback identity stays stable across a URL
  // change — the chips and the tag facets are re-rendered on every filter as it is.
  const toggleStatusFilter = useCallback(
    (status: ItemStatusFilter) =>
      setView((v) => ({
        statuses: v.statuses.includes(status)
          ? v.statuses.filter((s) => s !== status)
          : [...v.statuses, status],
      })),
    [setView],
  );
  const clearStatusFilters = useCallback(() => setView({ statuses: [] }), [setView]);

  const toggleTag = useCallback(
    (tagId: string) =>
      setView((v) => ({
        tagIds: v.tagIds.includes(tagId) ? v.tagIds.filter((id) => id !== tagId) : [...v.tagIds, tagId],
      })),
    [setView],
  );

  // Both lists arrive canonically ordered from the URL — statuses in `ITEM_STATUS_FILTERS` order
  // (which mirrors the server-side ordering in buildStatusFilter), tag ids sorted — so the query
  // key is stable however the chips were toggled, and two URLs meaning one view read the same.
  const statusList = view.statuses;
  const tagIdList = view.tagIds;
  // The repository's `sort` argument for the chosen ordering — `undefined` under the default
  // order, so the filter slice (and therefore the query key) is unchanged for a user who never
  // touches the control. Memoised so the array identity is stable across renders.
  const itemSort = useMemo(() => toItemSort(inventorySort), [inventorySort]);

  const filters: ItemQueryFilters = useMemo(
    () => ({
      ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(tagIdList.length > 0 ? { tagIds: tagIdList } : {}),
      ...(search ? { search } : {}),
      includeInactive,
      // Absent for the default order, so the repository keeps its own favourites-first ordering
      // (and the query key stays identical to the pre-sort one).
      ...(itemSort ? { sort: itemSort } : {}),
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
      itemSort,
      statusList,
      lowStockQtyThreshold,
      lowStockGaugePercent,
      expirySoonWindowDays,
    ],
  );

  const tree = useLocationTree();
  const flat = useLocations();
  const totalCount = useItemCount({ includeInactive });
  // In paginated mode the infinite list is suspended and the page read (below) drives the list, so
  // the two never both run; otherwise the infinite list feeds the virtualised scroll as before.
  const listItems = useInventoryItems(filters, undefined, !paginated);
  // The chosen ordering applies to Visual-search results too — otherwise the Sort control would
  // silently do nothing while the builder drives the list.
  const astItems = useAstSearch(ast, astActive, itemSort, astLocationId);
  const active = astActive ? astItems : listItems;
  // Discrete-pagination reads (issue #20), gated off unless the flat list is paginated: one page of
  // rows plus the filtered total that sizes the page count.
  const pageItems = useItemPage(filters, page, defaultPageSize, paginated);

  // How many items actually **match** — the number the result summary announces, and the one that
  // sizes the page count while paginating (issue #220). It must come from a `COUNT(*)`, never from
  // the resident rows: the infinite list trims its leading pages as the user scrolls, so a row
  // count answers "how far have I scrolled" rather than "how much matched", and drifts without any
  // filter having changed. The grouped view ignores the sidebar selection (it lists every
  // location), so its count drops `locationId` to stay honest about what is on screen.
  const countFilters = useMemo(() => {
    if (!grouped) return filters;
    const { locationId: _locationId, ...rest } = filters;
    return rest;
  }, [grouped, filters]);
  // Neither consumer exists under a whole-collection visualisation — the summary line and the
  // pagination control are both hidden then — so don't spend a `COUNT(*)` the map/treemap
  // can't show. (The AST count below stays ungated: the builder panel is still on screen.)
  const matchCount = useItemCount(countFilters, !astActive && !isVizMode);
  const astMatchCount = useAstCount(ast, astActive, astLocationId);
  const resultCount = astActive ? astMatchCount : matchCount;
  const matchTotal = resultCount.data ?? 0;

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
  // Also gated off while a whole-collection visualisation is on screen: the filter bar these
  // counts feed is hidden then (see `isVizMode`), so the per-location round-trip is wasted work.
  const applicableStatusesQuery = useApplicableStatuses(selectedLocationId, !astActive && !isVizMode);
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
  // The location's optional swatch as a card/row edge-tint class (visual-flair F10), so an item
  // reads as belonging to its location at a glance — resolved from the same `locationColors` map
  // as the label tint above, never a second colour scheme.
  const locationTintClass = (id: string) => locationColorTintClass(locationColors.get(id));

  const flatItems = useMemo(
    () => (paginated ? (pageItems.data?.rows ?? []) : (active.data?.pages.flatMap((p) => p.rows) ?? [])),
    [paginated, pageItems.data, active.data],
  );
  // Absolute index of the first resident item: non-zero once `maxPages` has trimmed off the
  // leading page(s), so the virtualised list can index in absolute space. A discrete page always
  // starts at 0 (it holds exactly its own rows, not an absolute-indexed window).
  const firstItemIndex = paginated ? 0 : (active.data?.pages[0]?.offset ?? 0);
  // The query whose loading/success gates the list's spinner + "shown" line — the page read in
  // paginated mode, the infinite/AST read otherwise.
  const listStatus = paginated ? pageItems : active;
  // Total pages for the control, from the filtered count (only fetched while paginating).
  const totalPages = pageCount(matchCount.data ?? 0, defaultPageSize);
  // If the result set shrinks below the current page (e.g. items removed, or a narrower filter),
  // clamp back into range. A correction rather than a navigation the user made, so it replaces:
  // Back from here should leave the screen, not step onto a page that no longer exists.
  //
  // It waits for a count that is actually about the current filters. `useItemCount` holds the
  // previous number while a new one loads (`keepPreviousData`), and that stale number is for a
  // *different* result set — clamping against it would rewrite a page the user had just returned
  // to with Back.
  useEffect(() => {
    if (!paginated || matchCount.isPlaceholderData) return;
    if (totalPages > 0 && page > totalPages) setPage(totalPages, { replace: true });
  }, [paginated, totalPages, page, setPage, matchCount.isPlaceholderData]);
  // Memoised for its *identity*, not its cost: it is passed to every rendered row, and each row is
  // `memo`-compared prop by prop. A bare `?? []` mints a fresh empty array on every render, so
  // until the locations query settles, every keystroke in the search box re-rendered every card
  // (issue #419).
  const flatLocations = useMemo(() => flat.data?.rows ?? [], [flat.data]);
  // The selected location's live row (with its item count), for the compact summary card.
  //
  // Taken from the **tree**, not the flat list: the summary card draws a cube-utilisation bar,
  // which needs the volume totals only the tree read asks for. The flat list stays on the cheap
  // read the pickers want, so the aggregate runs once for the screen rather than twice (#525).
  const selectedLocation = useMemo(
    () => (selectedLocationId ? (findTreeNode(tree.data ?? [], selectedLocationId) ?? null) : null),
    [tree.data, selectedLocationId],
  );
  // What the list is currently scoped to, in words — shown on the compact drawer trigger, which
  // stands in for the master pane's own highlighted row. With no location selected (or its row
  // not yet loaded) that is the tree's own synthetic "All items" row, so the two always agree.
  const selectedLocationLabel = selectedLocation?.name ?? t('inventory.locations.allItems');

  // Configurable item-card fields (backlog E1): the shared order/catalog/category resolver,
  // plus — only for the custom fields actually shown — their stored values for the resident
  // window (so the virtualised cards render them without a per-card fetch). Passing the field
  // ids keeps that read to what the cards draw rather than every value the items hold (#560).
  const cardFieldsConfig = useCardFieldsConfig();
  const residentItemIds = useMemo(() => flatItems.map((i) => i.id), [flatItems]);
  const cardFieldValues = useItemFieldValues(residentItemIds, cardFieldsConfig.visibleCustomFieldIds);
  const cardFieldTags = useItemsTags(residentItemIds, cardFieldsConfig.hasTagsField);
  const cardFields: CardFieldsListContext = {
    ...cardFieldsConfig,
    values: cardFieldValues.data,
    itemTags: cardFieldTags.data,
  };

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
  // location change keeps the gentle vertical swap-in. We remount the list wrapper on either
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
      : density === 'visual'
        ? 'animate-slide-in-left'
        : 'animate-slide-in-right'
    : 'animate-swap-in-slow';
  // Re-key (and so replay the entrance) when the *arrangement* changes: switching between
  // flat and grouped swaps the whole region. Grouped mode keeps a density-stable key so a
  // Data↔Visual restyle doesn't remount and lose the sections' expanded state, and it
  // ignores the sidebar selection (every location is shown as its own section). The
  // whole-collection visualisations own their own internal navigation (the map's drill-in root),
  // so they too key off the density alone — folding the sidebar selection into their key would
  // remount them (and reset that state) the moment a tile selects a location.
  const listKey = grouped
    ? 'group-location'
    : isVizMode
      ? `view-${density}`
      : `view-${density}-${selectedLocationId ?? 'all'}`;

  // Re-ordering or re-slicing the list means the page the user is on no longer names the same
  // rows, so both controls start again at the top. Done at the control rather than in an effect
  // watching the query: an effect cannot tell a preference change from a Back onto an entry that
  // held different filters, and would rewrite the very page Back had just restored. Neither
  // choice is a search param, so neither can arrive from the URL.
  const changeSort = useCallback(
    (next: InventorySort) => {
      setInventorySort(next);
      setPage(1, { replace: true });
    },
    [setInventorySort, setPage],
  );
  const changePageSize = useCallback(
    (size: number) => {
      setDefaultPageSize(size);
      setPage(1, { replace: true });
    },
    [setDefaultPageSize, setPage],
  );

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

  // Open a location from the Location map: select it in the sidebar and drop into the card view so
  // its items are immediately in front of the user (the map is a launcher into the list).
  const browseLocation = useCallback(
    (id: string) => {
      setSelectedLocationId(id);
      withViewTransition(() => setDensity('visual'));
    },
    [setDensity, setSelectedLocationId],
  );

  // Duplicate the single selected item (enabled only when exactly one is selected). The clone
  // appears in the list on invalidation; the selection is cleared and the outcome announced.
  const duplicateSelected = async () => {
    const sourceId = selectedItemIds[0];
    if (!mayWriteItems || selected.size !== 1 || !sourceId) return;
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
                className={`pl-9 ${searchInput && !astActive ? 'pr-16' : 'pr-9'}`}
                aria-label="Search items"
                disabled={astActive}
              />
              {/* In-box adornments: the usual clear "✕" (only with text to clear) and the saved-
                  searches toggle, which is always offered — it *is* the discovery point for the
                  feature (issue #136), so hiding it until there's something saved would defeat it. */}
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {searchInput && !astActive ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                    data-testid="inventory-search-clear"
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4"
                  >
                    <CloseIcon />
                  </button>
                ) : null}
                <Tooltip content={t('inventory.savedSearches.tooltip')} triggerTabIndex={-1}>
                  <button
                    type="button"
                    onClick={() => setSavedSearchesOpen((open) => !open)}
                    aria-label={t('inventory.savedSearches.toggle')}
                    aria-expanded={savedSearchesOpen}
                    aria-controls={savedSearchesId}
                    data-testid="inventory-saved-searches-toggle"
                    className={cn(
                      'rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4',
                      savedSearchesOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <SavedSearchIcon aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </div>

            {/* Add item is a split button: the primary half opens the create dialog, and the
                attached chevron offers Import… (the same entry point the dashboard hero uses).
                Import lives here rather than in the "More" menu so there is one obvious place
                to bring items in — beside the button that adds them. Placed right after search
                (mirroring the dashboard hero's Search → Add item → Scan order) so the primary
                actions stay grouped together at the front of the row; if the row must wrap at
                a narrow width, it's the less-common view controls below that give way first. */}
            <Button
              onClick={() => setAddOpen(true)}
              data-testid="inventory-add-item"
              menuLabel="More add-item actions"
              menuTriggerProps={{ 'data-testid': 'inventory-add-menu' }}
              // Import is the chevron's only entry, so a session refused it gets no chevron at
              // all — an undefined `menu` collapses the split button back to a plain one rather
              // than leaving an empty panel hanging off it.
              menu={
                mayImport ? (
                  <MenuAction
                    icon={<ImportIcon />}
                    onSelect={() => setImportOpen(true)}
                    data-testid="open-catalog-import"
                  >
                    Import…
                  </MenuAction>
                ) : undefined
              }
            >
              <AddIcon />
              Add item
            </Button>

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
                selectionRole="checkbox"
              >
                Visual search
              </MenuAction>
              <MenuSeparator />
              {/* The three arrangement axes: View (how each item is *drawn*: Card / Data / Table),
                  Group by (how the list is *arranged*) and Sort by (what order it runs in). Each is
                  a nested submenu holding its own modes — rendered off its own descriptor SSOT, so a
                  future mode needs no menu rework — with the trigger showing the current choice, and
                  each label resolved through the message catalog. */}
              <MenuSub
                icon={<activeDensity.icon />}
                label={t('inventory.view.trigger', { vars: { mode: t(activeDensity.labelKey) } })}
              >
                {DENSITY_MODES.map((mode) => (
                  <MenuAction
                    key={mode.value}
                    icon={<mode.icon />}
                    onSelect={() => withViewTransition(() => setDensity(mode.value))}
                    selected={density === mode.value}
                    selectionRole="radio"
                  >
                    {t(mode.labelKey)}
                  </MenuAction>
                ))}
              </MenuSub>
              <MenuSub
                icon={<GroupByIcon />}
                label={t('inventory.groupBy.trigger', { vars: { mode: t(activeGrouping.labelKey) } })}
              >
                {GROUP_MODES.map((mode) => (
                  <MenuAction
                    key={mode.value}
                    onSelect={() => setGrouping(mode.value)}
                    selected={grouping === mode.value}
                    selectionRole="radio"
                  >
                    {t(mode.labelKey)}
                  </MenuAction>
                ))}
              </MenuSub>
              {/* Sort by (the ordering axis, issue #128) — the third arrangement axis, rendered
                  off the same kind of descriptor SSOT. Picking a field applies its natural
                  direction (A → Z for text, newest/largest first for dates and numbers); the
                  direction pair below then names what each way *means* for the chosen field,
                  and is omitted under the default order, which has no direction to offer. */}
              <MenuSub
                icon={<SortIcon />}
                label={t('inventory.sort.trigger', { vars: { mode: t(activeSort.labelKey) } })}
              >
                {SORT_MODES.map((mode) => (
                  <MenuAction
                    key={mode.value}
                    onSelect={() =>
                      changeSort({ field: mode.value, direction: initialDirection(mode.value) })
                    }
                    selected={inventorySort.field === mode.value}
                    selectionRole="radio"
                  >
                    {t(mode.labelKey)}
                  </MenuAction>
                ))}
                {sortDirections ? (
                  <>
                    <MenuSeparator />
                    {SORT_DIRECTIONS.map((direction) => (
                      <MenuAction
                        key={direction}
                        icon={direction === 'asc' ? <SortAscIcon /> : <SortDescIcon />}
                        onSelect={() => changeSort({ field: inventorySort.field, direction })}
                        selected={inventorySort.direction === direction}
                        selectionRole="radio"
                      >
                        {t(sortDirections.keys[direction])}
                      </MenuAction>
                    ))}
                  </>
                ) : null}
              </MenuSub>
              <MenuSeparator />
              <MenuAction
                icon={<InfoIcon />}
                onSelect={toggleLocationCard}
                selected={showLocationCard}
                selectionRole="checkbox"
                data-testid="toggle-location-info"
              >
                Location summary
              </MenuAction>
              {/* Paginate long lists (issue #20) — an app-wide view preference (mirrored in
                  Settings). Splits the flat list into fixed-size pages; ignored while grouped or a
                  whole-collection visualisation is on screen. */}
              <MenuAction
                icon={<DataDensityIcon />}
                onSelect={() => setPaginateLists(!paginateLists)}
                selected={paginateLists}
                selectionRole="checkbox"
                data-testid="toggle-paginate"
              >
                Paginate list
              </MenuAction>
              {/* Fullscreen (issue #118) — toggles the browser's fullscreen mode so the app fills
                  the whole display. Only offered where the browser exposes the Fullscreen API. */}
              {fullscreenSupported ? (
                <MenuAction
                  icon={isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
                  onSelect={toggleFullscreen}
                  selected={isFullscreen}
                  selectionRole="checkbox"
                  data-testid="toggle-fullscreen"
                >
                  Fullscreen
                </MenuAction>
              ) : null}
              <MenuSeparator />
              <MenuAction icon={<CategoryIcon />} onSelect={() => setCategoriesOpen(true)}>
                Categories
              </MenuAction>
              <MenuAction icon={<TagIcon />} onSelect={() => void navigate({ to: '/tags' })}>
                Tags
              </MenuAction>
              {cycleCountsEnabled ? (
                <>
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
                </>
              ) : null}
              {mayExport ? (
                <>
                  <MenuSeparator />
                  <MenuAction
                    icon={<ExportIcon />}
                    onSelect={() => setExportOpen(true)}
                    data-testid="open-export-wizard"
                  >
                    Export
                  </MenuAction>
                </>
              ) : null}
              <MenuSeparator />
              <MenuAction
                icon={<SelectIcon />}
                onSelect={toggleSelecting}
                selected={selecting}
                selectionRole="checkbox"
                data-testid="toggle-select"
              >
                Select items
              </MenuAction>
            </Menu>
          </>
        }
      />

      {/* Saved-searches reveal (issue #136) — the same collapsing-grid disclosure the Visual
          search panel below uses, so the two behave identically. It hosts the *same*
          SavedSearchMenu the power box does, so saving, recalling and forgetting a search work
          identically whichever box you came from — there is one saved-search UI, not two.
          Recall routes through `recallSavedSearch`, which decides between this box and the
          builder. */}
      <div
        className="grid transition-[grid-template-rows,opacity] duration-1000 ease-emphasized"
        style={{
          gridTemplateRows: savedSearchesOpen ? '1fr' : '0fr',
          opacity: savedSearchesOpen ? 1 : 0,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            id={savedSearchesId}
            className="pb-4"
            inert={!savedSearchesOpen}
            data-testid="inventory-saved-searches"
          >
            <Surface className="space-y-2 p-4">
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary [&_svg]:size-4">
                  <SavedSearchIcon aria-hidden />
                </span>
                <h2 className="text-sm font-semibold">{t('inventory.savedSearches.toggle')}</h2>
                <CloseButton
                  className="ml-auto"
                  onClick={() => setSavedSearchesOpen(false)}
                  label={t('inventory.savedSearches.close')}
                />
              </div>
              <SavedSearchMenu currentQuery={searchInput} onRecall={recallSavedSearch} />
              <p className="text-[11px] text-muted-foreground">{t('inventory.savedSearches.hint')}</p>
            </Surface>
          </div>
        </div>
      </div>

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
                // The true match count, not the resident-page count (issue #220) — named with
                // the location it is scoped to, so the panel agrees with the sidebar (#626).
                astActive
                  ? // Only name the location once it has resolved — `selectedLocationLabel`
                    // falls back to "All items" until then, which would misdescribe the scope.
                    astLocationId && selectedLocation
                    ? t('inventory.results.builderSummaryInLocation', {
                        vars: { count: matchTotal, location: selectedLocationLabel },
                      })
                    : t('inventory.results.builderSummary', { vars: { count: matchTotal } })
                  : undefined
              }
              onClose={() => setBuilderOpen(false)}
            />
          </div>
        </div>
      </div>

      {/* Drag-to-move (spec §4): the provider owns the unified pointer drag and must wrap both
          the drop targets (the sidebar) and the drag sources (the item list). */}
      <ItemDragProvider>
        {/* Wide: master pane beside the list. Compact: the pane is in the drawer below, and
            the row stacks so its trigger sits directly above the items it scopes. */}
        <div className={cn('flex min-h-0 flex-1', compact ? 'flex-col gap-3' : 'gap-6 large-format:gap-8')}>
          {compact ? (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => setLocationsDrawerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={locationsDrawerOpen}
              aria-label={t('inventory.locations.drawer.trigger', {
                vars: { location: selectedLocationLabel },
              })}
              data-testid="open-locations-drawer"
            >
              <LocationTreeIcon />
              {t('inventory.locations.title')}
              {/* The scope the list is currently showing, so the trigger doubles as the
                  breadcrumb the master pane would otherwise give you at a glance. */}
              <span aria-hidden className="min-w-0 truncate font-normal text-muted-foreground">
                {selectedLocationLabel}
              </span>
            </Button>
          ) : tree.data && flat.data ? (
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
            {selectedLocation && !isVizMode ? (
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

            {/* The selected location's own detail — its description as rich Markdown, plus the
                custom-field values it holds about itself (issues #108, #617). Independent of the
                compact summary card above: it is never dismissed, and it renders itself away when
                the location holds neither, so the gate here is only "a location is selected and
                we're not in a whole-collection visualisation". */}
            {selectedLocation && !isVizMode ? <LocationDetailCard location={selectedLocation} /> : null}

            {/* The filter/facet bars and the "shown" count belong to the item list; a
                whole-collection visualisation (map/treemap) stands alone, so they're hidden then. */}
            {!isVizMode ? (
              <>
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
                  locationId={selectedLocationId}
                  tagIds={tagIds}
                  onToggleTag={toggleTag}
                  disabled={astActive}
                />

                <div className="flex items-center justify-between pb-3">
                  {/* The one place that answers "did my filter match anything, and how much?" —
                      so it announces the **match total**, never the resident row count (issue
                      #220). Grouped mode carries the same total, since a grouped list is just as
                      filtered as a flat one. */}
                  <p
                    className="text-sm text-muted-foreground"
                    role="status"
                    aria-live="polite"
                    data-testid="inventory-result-summary"
                  >
                    {!resultCount.isSuccess
                      ? t('inventory.results.loading')
                      : grouped
                        ? t('inventory.results.grouped', { vars: { count: matchTotal } })
                        : astActive
                          ? // Named only once the location has resolved — see the builder
                            // panel's summary above.
                            astLocationId && selectedLocation
                            ? t('inventory.results.visualSearchInLocation', {
                                vars: { count: matchTotal, location: selectedLocationLabel },
                              })
                            : t('inventory.results.visualSearch', { vars: { count: matchTotal } })
                          : t('inventory.results.count', { vars: { count: matchTotal } })}
                  </p>
                  {/* Only shown when it applies (removed items exist in view, or it's already on) —
                      see `showRemovedToggle`. The help badge sits outside the label so a tap on the
                      hint doesn't toggle the checkbox. */}
                  {showRemovedToggle ? (
                    <div className="flex items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={includeInactive}
                          onChange={(e) => setIncludeInactive(e.target.checked)}
                          className="size-3.5"
                        />
                        Show removed
                      </label>
                      <InfoHint content={SHOW_REMOVED_HINT} />
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {!isVizMode && selecting ? (
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
                  {mayWriteItems ? (
                    <>
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
                    </>
                  ) : null}
                  {reportsEnabled && mayReadReports ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        useCatalogueLaunch.getState().launch({ kind: 'items', itemIds: [...selectedIds] });
                        void navigate({ to: '/catalogue' });
                      }}
                      disabled={selected.size === 0}
                      data-testid="print-catalogue"
                    >
                      <CatalogueIcon />
                      Catalogue
                    </Button>
                  ) : null}
                  {labelsEnabled && mayPrintLabels ? (
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
              blinking into place. A location change plays the gentle vertical swap-in; a
              view-mode change plays the horizontal slide chosen in `listEntrance`.
              (Search-as-you-type deliberately doesn't re-key, so typing never flashes the
              list.) Reduced-motion is handled by the global catch-all. */}
            <div key={listKey} className={cn('flex min-h-0 flex-1 flex-col', listEntrance)}>
              {density === 'map' ? (
                tree.data ? (
                  <LocationMapView
                    tree={tree.data}
                    onSelectLocation={setSelectedLocationId}
                    onBrowseLocation={browseLocation}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <Spinner />
                  </div>
                )
              ) : density === 'treemap' ? (
                <ValueTreemapView grouping={grouping} />
              ) : grouped ? (
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
                    locationTintClass={locationTintClass}
                    selection={selection}
                    selectedIds={selectedIds}
                    cardFieldsConfig={cardFieldsConfig}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <Spinner />
                  </div>
                )
              ) : listStatus.isLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Spinner />
                </div>
              ) : listStatus.isError ? (
                // Never fall through to the list's empty state on failure: an empty
                // inventory and a failed read would render byte-identically, and "nothing
                // here" is the most alarming possible misreport for stock that is actually
                // just unreadable (issue #306). Offer a retry so it's recoverable in place.
                <div className="flex flex-1 items-center justify-center p-4">
                  <Surface className="flex flex-col items-center gap-3 p-6 text-center">
                    <p role="alert" className="text-sm text-destructive">
                      {t('inventory.list.error')}
                    </p>
                    <Button variant="outline" onClick={() => void listStatus.refetch()}>
                      {t('inventory.list.retry')}
                    </Button>
                  </Surface>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <ItemList
                    items={flatItems}
                    firstItemIndex={firstItemIndex}
                    // The true match total, so each card/row announces "item 12 of 340" even though
                    // only a screenful is mounted (issue #208). Left undefined while the count is
                    // still resolving, and in paginated mode — there the list *is* the page, so its
                    // own resident rows are the honest set size.
                    totalCount={paginated ? undefined : resultCount.data}
                    locations={flatLocations}
                    density={density}
                    selectedLocationId={selectedLocationId}
                    locationName={locationName}
                    locationColorClass={locationColorClass}
                    locationTintClass={locationTintClass}
                    // In paginated mode the list holds exactly one page, so the infinite-scroll
                    // fetch triggers are disabled — the page control drives navigation instead.
                    hasNextPage={!paginated && active.hasNextPage}
                    isFetchingNextPage={!paginated && active.isFetchingNextPage}
                    fetchNextPage={() => {
                      if (!paginated) void active.fetchNextPage();
                    }}
                    hasPreviousPage={!paginated && active.hasPreviousPage}
                    isFetchingPreviousPage={!paginated && active.isFetchingPreviousPage}
                    fetchPreviousPage={() => {
                      if (!paginated) void active.fetchPreviousPage();
                    }}
                    childLocations={childLocations}
                    onSelectLocation={setSelectedLocationId}
                    selection={selection}
                    selectedIds={selectedIds}
                    cardFields={cardFields}
                    emptyContext={
                      astActive
                        ? { visualSearch: true, visualSearchScoped: astLocationId !== null }
                        : {
                            search,
                            statusFilterCount: statusFilters.size,
                            categoryFilter: Boolean(categoryId),
                            tagFilterCount: tagIds.length,
                          }
                    }
                  />
                  {paginated ? (
                    <Pagination
                      page={page}
                      pageCount={totalPages}
                      onPageChange={setPage}
                      pageSize={defaultPageSize}
                      onPageSizeChange={changePageSize}
                      pageSizeOptions={PAGE_SIZE_PRESETS}
                      minPageSize={PAGE_SIZE_BOUNDS.min}
                      maxPageSize={PAGE_SIZE_BOUNDS.max}
                      totalItems={matchCount.data ?? 0}
                      className="px-4"
                      data-testid="inventory-pagination"
                    />
                  ) : null}
                </div>
              )}
            </div>
          </main>
        </div>

        {/* The compact home of the master pane. Kept inside the drag provider so drag-to-*nest*
            still works (a location row is dragged onto another, both inside the drawer), and so
            the add/edit dialogs it opens stack on the drawer via the shared modal stack.

            Drag-to-*move* — an item card onto a location row — is not reachable here, and can't
            be: with the drawer shut there is no row on screen, and with it open the backdrop
            covers the very cards you would drag from. `beginDrag` therefore refuses to arm while
            nothing is registered as a drop target, so the gesture is inert rather than doomed.
            Nothing is lost that the compact layout didn't already lack: the pointer drag has
            always been an additive affordance over the keyboard-accessible "Move item" action
            and the Edit-location Parent field, which stay the complete paths. */}
        {compact && locationsDrawerOpen ? (
          <Drawer open onClose={() => setLocationsDrawerOpen(false)} title={t('inventory.locations.title')}>
            {tree.data && flat.data ? (
              <LocationSidebar
                compact
                tree={tree.data}
                flat={flatLocations}
                selectedId={selectedLocationId}
                onSelect={setSelectedLocationId}
                // Picking a location is the drawer's whole purpose, so it closes on choice and
                // hands the screen straight back to the items now in scope. Only a *deliberate*
                // pick closes it: the sidebar also clears the selection on the user's behalf when
                // the selected location is deleted or archived out of view (issue #713), and
                // taking the pane away because a filter toggle did that would be a non-sequitur.
                onPick={() => setLocationsDrawerOpen(false)}
                totalCount={totalCount.data ?? 0}
              />
            ) : (
              <div className="flex justify-center pt-8">
                <Spinner />
              </div>
            )}
          </Drawer>
        ) : null}
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
            setScanProduct(null);
          }}
          locations={flatLocations}
          defaultLocationId={defaultLocationForNewItem(
            selectedLocationId,
            flatLocations,
            markedDefaultLocationId(flatLocations),
          )}
          initialValues={
            scanBarcode
              ? {
                  barcode: scanBarcode,
                  name: scanProduct?.name,
                  manufacturer: scanProduct?.brand ?? undefined,
                  description: scanProduct?.description ?? undefined,
                }
              : undefined
          }
        />
      ) : null}
      <CategoryManagerDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      {cycleCountsEnabled && cycleCountOpen && selectedLocationId ? (
        <CycleCountDialog
          open
          onClose={() => setCycleCountOpen(false)}
          location={{ id: selectedLocationId, name: locationName(selectedLocationId) }}
        />
      ) : null}
      {cycleCountsEnabled ? (
        <AuditDayDialog open={auditDayOpen} onClose={() => setAuditDayOpen(false)} />
      ) : null}
      <ScannerOverlay
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onLocationScanned={(id) => {
          setSelectedLocationId(id);
          setScannerOpen(false);
        }}
        onCreateFromBarcode={(gtin, product) => {
          setScannerOpen(false);
          setScanBarcode(gtin);
          setScanProduct(product ?? null);
          setAddOpen(true);
        }}
        onViewItem={(item) => {
          // Jump-to-item, mirroring the command palette / alert deep-links: seed the search so
          // the item is in view even if a filter would hide it, then flash its card.
          setScannerOpen(false);
          // Both halves of the box: the URL is what the query reads, and the input is what the
          // user sees — set together so the debounce below has nothing left to commit.
          setSearchInput(item.name);
          setView({ search: item.name });
          requestHighlight(item.id);
        }}
      />
      {/* The dialogs answer to the same keys as the controls that open them, so a capability
          revoked mid-session takes down what is already on screen rather than leaving a live
          wizard behind a button that has gone. */}
      {mayExport ? (
        <ExportWizard
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          initialLocationId={selectedLocationId}
        />
      ) : null}
      {mayImport ? <ImportDataDialog open={importOpen} onClose={() => setImportOpen(false)} /> : null}
      {/* Deep-linked item detail (e.g. from a Reports data-hygiene row): open the card directly
          so the user lands on the item rather than hunting for it. Rendered only once the record
          has loaded; closing clears the id so the query goes idle again. */}
      {detailItem.data ? (
        <ItemDetailDialog item={detailItem.data} open onClose={() => setDetailItemId(null)} />
      ) : null}
      {mayPrintLabels ? (
        <PrintLabelsDialog open={printOpen} onClose={() => setPrintOpen(false)} items={selectedLabels} />
      ) : null}
      {mayWriteItems ? (
        <BulkEditDialog
          open={bulkEditOpen}
          onClose={() => setBulkEditOpen(false)}
          itemIds={selectedItemIds}
          locations={flatLocations}
          onApplied={({ message, undo, hadFailures }) => {
            setSelected(new Map());
            // Announced by the toast (its viewport is aria-live), not the live region below — a
            // bulk edit is reversible, and the Undo has to be reachable from the same surface
            // that reports the outcome. Pushing the sentence into both would announce it twice.
            undoToast(message, undo, hadFailures ? 'warning' : 'success');
          }}
        />
      ) : null}

      {/* Announce duplicate + saved-search outcomes (WCAG 4.1.3). Bulk edit announces
          through its own toast instead, so the Undo it carries is reachable from there. */}
      <LiveRegion visuallyHidden data-testid="inventory-action-live-region">
        {actionAnnouncement ? <p>{actionAnnouncement}</p> : null}
      </LiveRegion>
    </PageContainer>
  );
}
