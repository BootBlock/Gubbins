import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Input, Spinner, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  AddIcon,
  BrandIcon,
  BuilderIcon,
  CategoryIcon,
  CloseIcon,
  CloudIcon,
  ContactsIcon,
  CycleCountIcon,
  ExportIcon,
  PrintIcon,
  ProjectIcon,
  ScanIcon,
  SearchIcon,
  SelectIcon,
} from '@/components/icons';
import { Tooltip } from '@/components/foundry';
import { CycleCountDialog } from '@/features/lifecycle';
import { ScannerOverlay } from '@/features/scanner/components/ScannerOverlay';
import { ExportWizard } from '@/features/export/ExportWizard';
import { UNASSIGNED_LOCATION_ID, type Item } from '@/db/repositories';
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
import { LayoutToggle } from './components/LayoutToggle';
import { LocationSidebar } from './components/LocationSidebar';
import { ItemList } from './components/ItemList';
import { CreateItemDialog } from './components/CreateItemDialog';
import { CategoryManagerDialog } from './components/CategoryManagerDialog';
import { PrintLabelsDialog } from './components/PrintLabelsDialog';
import type { ItemSelection } from './components/inventory-ui';

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
  const [cycleCountOpen, setCycleCountOpen] = useState(false);
  // Multi-select for batch QR-label printing (spec §6, Phase 49). The selection
  // keeps id→name so it survives the bounded virtualised-list window (a selected
  // item whose page has been trimmed off still prints) and spans filter changes.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [printOpen, setPrintOpen] = useState(false);

  const { ast, conditionCount } = useSearchBuilder();
  // The Visual Builder supersedes the quick search/location filters when it is open
  // and holds at least one valid condition (spec §5.1).
  const astActive = builderOpen && conditionCount > 0 && astError(ast) === null;

  // Debounce the quick-search box so each keystroke doesn't hit the worker.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

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
            else next.set(item.id, item.name);
            return next;
          }),
      }
    : undefined;
  const selectedLabels = useMemo(
    () => Array.from(selected, ([id, name]) => ({ id, name })),
    [selected],
  );
  const toggleSelecting = () => {
    setSelecting((on) => {
      if (on) setSelected(new Map()); // leaving select mode clears the selection
      return !on;
    });
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-7xl flex-col px-4 pb-4 pt-4">
      <header className="flex flex-wrap items-center gap-3 pb-4">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary [&_svg]:size-5">
            <BrandIcon />
          </span>
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>

        <div className="relative ml-auto w-full max-w-xs">
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

        <Link
          to="/projects"
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <ProjectIcon />
          Projects
        </Link>

        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <ContactsIcon />
          Contacts
        </Link>

        <Link
          to="/sync"
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <CloudIcon />
          Sync
        </Link>

        <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
          <CategoryIcon />
          Categories
        </Button>

        <Tooltip content={selectedLocationId ? 'Blind-count this location' : 'Select a location to cycle count'}>
          <span>
            <Button
              variant="outline"
              onClick={() => setCycleCountOpen(true)}
              disabled={!selectedLocationId}
              data-testid="open-cycle-count"
            >
              <CycleCountIcon />
              Cycle count
            </Button>
          </span>
        </Tooltip>

        <Button variant="outline" onClick={() => setExportOpen(true)}>
          <ExportIcon />
          Export
        </Button>

        <Tooltip content="Tick multiple items to print a sheet of QR labels. Toggling off clears the selection." triggerTabIndex={-1}>
          <span>
            <Button
              variant={selecting ? 'secondary' : 'outline'}
              onClick={toggleSelecting}
              aria-pressed={selecting}
              data-testid="toggle-select"
            >
              <SelectIcon />
              Select
            </Button>
          </span>
        </Tooltip>

        <Button onClick={() => setAddOpen(true)}>
          <AddIcon />
          Add item
        </Button>
      </header>

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

      <CreateItemDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        locations={flatLocations}
        defaultLocationId={selectedLocationId ?? UNASSIGNED_LOCATION_ID}
      />
      <CategoryManagerDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      {cycleCountOpen && selectedLocationId ? (
        <CycleCountDialog
          open
          onClose={() => setCycleCountOpen(false)}
          location={{ id: selectedLocationId, name: locationName(selectedLocationId) }}
        />
      ) : null}
      <ScannerOverlay open={scannerOpen} onClose={() => setScannerOpen(false)} />
      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />
      <PrintLabelsDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        items={selectedLabels}
      />
    </div>
  );
}
