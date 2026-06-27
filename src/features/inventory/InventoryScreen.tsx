import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Input, Spinner } from '@/components/foundry';
import {
  AddIcon,
  BrandIcon,
  BuilderIcon,
  CategoryIcon,
  ContactsIcon,
  ExportIcon,
  ProjectIcon,
  ScanIcon,
  SearchIcon,
} from '@/components/icons';
import { ScannerOverlay } from '@/features/scanner/components/ScannerOverlay';
import { ExportWizard } from '@/features/export/ExportWizard';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
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
  const flatLocations = flat.data?.rows ?? [];

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

        <Button
          variant={builderOpen ? 'secondary' : 'outline'}
          onClick={() => setBuilderOpen((v) => !v)}
          aria-pressed={builderOpen}
        >
          <BuilderIcon />
          Visual search
        </Button>

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

        <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
          <CategoryIcon />
          Categories
        </Button>

        <Button variant="outline" onClick={() => setExportOpen(true)}>
          <ExportIcon />
          Export
        </Button>

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

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between pb-3">
            <p className="text-sm text-muted-foreground">
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

          {active.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <ItemList
              items={flatItems}
              locations={flatLocations}
              density={density}
              locationName={locationName}
              hasNextPage={active.hasNextPage}
              isFetchingNextPage={active.isFetchingNextPage}
              fetchNextPage={() => void active.fetchNextPage()}
            />
          )}
        </main>
      </div>

      <CreateItemDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        locations={flatLocations}
        defaultLocationId={selectedLocationId ?? UNASSIGNED_LOCATION_ID}
      />
      <CategoryManagerDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} />
      <ScannerOverlay open={scannerOpen} onClose={() => setScannerOpen(false)} />
      <ExportWizard open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
