import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Input, Spinner } from '@/components/foundry';
import { AddIcon, BrandIcon, CategoryIcon, SearchIcon } from '@/components/icons';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
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
 * The Phase 2 inventory workspace (spec §5): location sidebar, a search/filter
 * header with the Data-Heavy ↔ Visual-Heavy toggle, and the virtualised item list.
 */
export function InventoryScreen() {
  const density = useLayoutStore((s) => s.density);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  // Debounce the search box so each keystroke doesn't hit the worker.
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
  const items = useInventoryItems(filters);

  const locationNames = useMemo(() => {
    const map = new Map<string, string>();
    flat.data?.rows.forEach((loc) => map.set(loc.id, loc.name));
    return map;
  }, [flat.data]);
  const locationName = (id: string) => locationNames.get(id) ?? 'Unassigned';

  const flatItems = useMemo(() => items.data?.pages.flatMap((p) => p.rows) ?? [], [items.data]);
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
          />
        </div>

        <LayoutToggle />

        <Button variant="outline" onClick={() => setCategoriesOpen(true)}>
          <CategoryIcon />
          Categories
        </Button>

        <Button onClick={() => setAddOpen(true)}>
          <AddIcon />
          Add item
        </Button>
      </header>

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
              {items.isSuccess ? `${flatItems.length} shown` : 'Loading…'}
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

          {items.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <ItemList
              items={flatItems}
              locations={flatLocations}
              density={density}
              locationName={locationName}
              hasNextPage={items.hasNextPage}
              isFetchingNextPage={items.isFetchingNextPage}
              fetchNextPage={() => void items.fetchNextPage()}
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
    </div>
  );
}
