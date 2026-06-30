import { useEffect, useMemo, useState } from 'react';
import { Button, Input, LiveRegion, Spinner, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  AddIcon,
  BuilderIcon,
  CategoryIcon,
  CloseIcon,
  CycleCountIcon,
  DuplicateTabIcon,
  EditIcon,
  ExportIcon,
  ImportIcon,
  MoreIcon,
  PackageIcon,
  PrintIcon,
  ScanIcon,
  SearchIcon,
  SelectIcon,
} from '@/components/icons';
import { Menu, MenuAction, MenuSeparator, PageContainer, PageHeader, Tooltip } from '@/components/foundry';
import { CycleCountDialog } from '@/features/lifecycle';
import { ScannerOverlay } from '@/features/scanner/components/ScannerOverlay';
import { ExportWizard } from '@/features/export/ExportWizard';
import { type Item } from '@/db/repositories';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { SearchBuilderProvider, useSearchBuilder } from '@/features/search/SearchBuilderContext';
import { VisualBuilder } from '@/features/search/components/VisualBuilder';
import { astError, useAstSearch } from '@/features/search/queries';
import {
  useInventoryItems,
  useItemCount,
  useLocations,
  useLocationTree,
  type ItemQueryFilters,
} from './queries';
import { useInventoryEntry } from './useInventoryEntry';
import { LayoutToggle } from './components/LayoutToggle';
import { LocationSidebar } from './components/LocationSidebar';
import { ItemList } from './components/ItemList';
import { locationColorTextClass } from './location-color';
import { defaultLocationForNewItem } from './location-tree';
import { CreateItemDialog } from './components/CreateItemDialog';
import { CategoryManagerDialog } from './components/CategoryManagerDialog';
import { PrintLabelsDialog } from './components/PrintLabelsDialog';
import { CatalogImportWizard } from './components/CatalogImportWizard';
import { BulkEditDialog } from './components/BulkEditDialog';
import { useCloneItem } from './mutations';
import type { ItemSelection } from './components/inventory-ui';
import type { LabelItem } from './labels/label-sheet';

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
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [cycleCountOpen, setCycleCountOpen] = useState(false);
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
    useInventoryEntry.getState().clearIntent();
  }, [pendingIntent]);

  const filters: ItemQueryFilters = useMemo(
    () => ({
      ...(selectedLocationId ? { locationId: selectedLocationId } : {}),
      ...(search ? { search } : {}),
      includeInactive,
    }),
    [selectedLocationId, search, includeInactive],
  );

  const tree = useLocationTree();
  const flat = useLocations();
  const totalCount = useItemCount({ includeInactive });
  const listItems = useInventoryItems(filters);
  const astItems = useAstSearch(ast, astActive);
  const active = astActive ? astItems : listItems;

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

  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const selection: ItemSelection | undefined = selecting
    ? {
        selectedIds,
        onToggle: (item: Item) =>
          setSelected((prev) => {
            const next = new Map(prev);
            if (next.has(item.id)) next.delete(item.id);
            else
              next.set(item.id, {
                id: item.id,
                name: item.name,
                mpn: item.mpn,
                locationName: locationName(item.locationId),
                quantity: item.quantity,
              });
            return next;
          }),
      }
    : undefined;
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
        icon={<PackageIcon />}
        title="Inventory"
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search items…"
                className="pl-9"
                aria-label="Search items"
                disabled={astActive}
              />
            </div>

            <Tooltip content="Build complex queries graphically — combine fields, capabilities and AND/OR groups. Supersedes the quick search while active." triggerTabIndex={-1}>
              <span>
                <Button
                  variant={builderOpen ? 'secondary' : 'outline'}
                  onClick={() => setBuilderOpen((v) => !v)}
                  aria-pressed={builderOpen}
                >
                  <BuilderIcon />
                  Visual search
                </Button>
              </span>
            </Tooltip>

            <LayoutToggle />

            <Button variant="outline" onClick={() => setScannerOpen(true)}>
              <ScanIcon />
              Scan
            </Button>

            <Menu
              label="More inventory actions"
              trigger={
                <>
                  <MoreIcon />
                  More
                </>
              }
            >
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
              <MenuSeparator />
              <MenuAction icon={<ExportIcon />} onSelect={() => setExportOpen(true)}>
                Export
              </MenuAction>
              <MenuAction
                icon={<ImportIcon />}
                onSelect={() => setImportOpen(true)}
                data-testid="open-catalog-import"
              >
                Import CSV
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

            <Button onClick={() => setAddOpen(true)}>
              <AddIcon />
              Add item
            </Button>
          </>
        }
      />

      {builderOpen ? (
        <div className="pb-4">
          <VisualBuilder
            resultSummary={
              astActive ? `${flatItems.length} match${flatItems.length === 1 ? '' : 'es'}` : undefined
            }
          />
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-6">
        {tree.data && flat.data ? (
          <LocationSidebar
            tree={tree.data}
            flat={flatLocations}
            selectedId={selectedLocationId}
            onSelect={setSelectedLocationId}
            totalCount={totalCount.data ?? 0}
          />
        ) : (
          <div className="w-64 shrink-0" />
        )}

        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex min-w-0 flex-1 animate-rise flex-col outline-none"
        >
          <div className="flex items-center justify-between pb-3">
            <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
              {active.isSuccess
                ? `${flatItems.length} shown${astActive ? ' (visual search)' : ''}`
                : 'Loading…'}
            </p>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Show removed
            </label>
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
                <Tooltip content="Seed a new item from this one (item-as-template). Select exactly one item." triggerTabIndex={-1}>
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
                <Button
                  size="sm"
                  onClick={() => setPrintOpen(true)}
                  disabled={selected.size === 0}
                  data-testid="print-labels"
                >
                  <PrintIcon />
                  Print labels
                </Button>
                <Tooltip content="Leave select mode and clear the current selection." triggerTabIndex={-1}>
                  <span>
                    <Button variant="outline" size="sm" onClick={toggleSelecting} aria-label="Done selecting">
                      <CloseIcon />
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </div>
          ) : null}

          {/* Keyed by the selected location so switching location re-mounts this region
              and replays the quick swap-in entrance — the list visibly arrives rather
              than blinking into place. (Search-as-you-type deliberately doesn't re-key,
              so typing never flashes the list.) Reduced-motion is handled by the global
              catch-all. */}
          <div
            key={`loc-${selectedLocationId ?? 'all'}`}
            className="flex min-h-0 flex-1 animate-swap-in flex-col"
          >
            {active.isLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner />
              </div>
            ) : (
              <ItemList
                items={flatItems}
                firstItemIndex={firstItemIndex}
                locations={flatLocations}
                density={density}
                locationName={locationName}
                locationColorClass={locationColorClass}
                hasNextPage={active.hasNextPage}
                isFetchingNextPage={active.isFetchingNextPage}
                fetchNextPage={() => void active.fetchNextPage()}
                hasPreviousPage={active.hasPreviousPage}
                isFetchingPreviousPage={active.isFetchingPreviousPage}
                fetchPreviousPage={() => void active.fetchPreviousPage()}
                selection={selection}
              />
            )}
          </div>
        </main>
      </div>

      {/* Mounted only while open so the location default is re-seeded from the current
          sidebar selection on every open — a real, user-created location pre-fills the
          dialog's Location (the form captures `defaultLocationId` on mount). Mirrors the
          "Add location" dialog in LocationSidebar. */}
      {addOpen ? (
        <CreateItemDialog
          open
          onClose={() => setAddOpen(false)}
          locations={flatLocations}
          defaultLocationId={defaultLocationForNewItem(selectedLocationId, flatLocations)}
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
      <ScannerOverlay
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onLocationScanned={(id) => {
          setSelectedLocationId(id);
          setScannerOpen(false);
        }}
      />
      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />
      <CatalogImportWizard open={importOpen} onClose={() => setImportOpen(false)} />
      <PrintLabelsDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        items={selectedLabels}
      />
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
