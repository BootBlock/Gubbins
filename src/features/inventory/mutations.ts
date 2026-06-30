/**
 * Tier-1 write hooks for the inventory domain (spec §2.1).
 *
 * Item mutations apply **optimistic updates with onError rollback** — the spec's
 * defence against UI tearing during rapid successive inputs (e.g. repeated gauge
 * or quantity adjustments queuing in OPFS). Each hook snapshots the affected cache
 * slices in `onMutate`, patches them immediately, restores them in `onError`, and
 * reconciles with the worker in `onSettled` via targeted invalidation.
 *
 * Location mutations reshape a tree whose optimistic mutation is error-prone and
 * low-frequency, so they use straightforward invalidation rather than optimistic
 * patching — a deliberate, scoped simplification.
 */
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  getCategoryRepository,
  getItemRepository,
  getLocationRepository,
  getSupplierPartRepository,
  getTagRepository,
  type CreateItemInput,
  type CreateLocationInput,
  type CreateSupplierPartInput,
  type GaugeAdjustment,
  type Item,
  type Page,
  type ScrapeApplyInput,
  type UpdateItemInput,
  type UpdateLocationInput,
  type UpdateSupplierPartInput,
} from '@/db/repositories';
import { currentGrossWeight, percentageRemaining } from '@/db/repositories/gauge';
import { inventoryKeys } from './queries';
import { resolveItemTagNames, type BulkEditSpec } from './bulk-edit';
import {
  clonedFieldValues,
  clonedSupplierPartInput,
  planItemClone,
} from './clone';

type ItemListData = InfiniteData<Page<Item>, number>;

/** Snapshot of every cached item-list slice, for rollback. */
type ListSnapshot = Array<[readonly unknown[], ItemListData | undefined]>;

const itemListFilter = {
  // Match only the infinite list queries — exactly ['inventory','items','list',filters].
  // The count query (…,'list',filters,'count') has length 5 and holds a number,
  // so it must be excluded or the InfiniteData updater would crash on it.
  predicate: (query: { queryKey: readonly unknown[] }) =>
    query.queryKey.length === 4 &&
    query.queryKey[0] === 'inventory' &&
    query.queryKey[1] === 'items' &&
    query.queryKey[2] === 'list',
} as const;

/** Apply a transform to a single item across every cached list page + its detail. */
function patchItem(client: QueryClient, id: string, patch: (item: Item) => Item): void {
  client.setQueriesData<ItemListData>(itemListFilter, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            rows: page.rows.map((item) => (item.id === id ? patch(item) : item)),
          })),
        }
      : data,
  );
  client.setQueryData<Item | undefined>(inventoryKeys.item(id), (item) =>
    item ? patch(item) : item,
  );
}

/** Cancel in-flight list fetches and snapshot them so onError can restore. */
async function snapshotLists(client: QueryClient): Promise<ListSnapshot> {
  await client.cancelQueries(itemListFilter);
  return client.getQueriesData<ItemListData>(itemListFilter);
}

function restoreLists(client: QueryClient, snapshot: ListSnapshot | undefined): void {
  snapshot?.forEach(([key, data]) => client.setQueryData(key, data));
}

/** Recompute a gauge item's derived (non-persisted) fields after a net-value change. */
function withGaugeNet(item: Item, nextNet: number): Item {
  if (!item.gauge) return item;
  const clamped = Math.max(0, nextNet);
  return {
    ...item,
    gauge: {
      ...item.gauge,
      currentNetValue: clamped,
      percentageRemaining: percentageRemaining(clamped, item.gauge.grossCapacity),
      currentGrossWeight: currentGrossWeight(clamped, item.gauge.tareWeight),
    },
  };
}

// --- Item mutations -------------------------------------------------------------

export function useCreateItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateItemInput) => getItemRepository().create(input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/**
 * Create N distinct SERIALISED instance records sharing a name (spec §4 auto-clone).
 * Invalidation-based: a batch insert reshapes the list more than a single optimistic
 * patch can cleanly express.
 */
export function useCreateSerialisedItems() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateItemInput) => getItemRepository().createSerialised(input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

export function useUpdateItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateItemInput }) =>
      getItemRepository().update(id, input),
    onMutate: async ({ id, input }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, ...stripUndefined(input) }));
      return { lists };
    },
    onError: (_e, _v, ctx) => restoreLists(client, ctx?.lists),
    onSettled: (_d, _e, { id }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.item(id) });
    },
  });
}

/**
 * Apply an external-scrape merge atomically (spec §4, §9). Invalidation-based: the
 * write touches item fields, aliases and the Activity Ledger together, so a full
 * refresh of the affected slices is simpler and safer than an optimistic patch.
 */
export function useApplyScrape() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, write }: { id: string; write: ScrapeApplyInput }) =>
      getItemRepository().applyScrape(id, write),
    onSettled: (_d, _e, { id }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.item(id) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

export function useMoveItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, locationId }: { id: string; locationId: string }) =>
      getItemRepository().move(id, locationId),
    onMutate: async ({ id, locationId }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, locationId }));
      return { lists };
    },
    onError: (_e, _v, ctx) => restoreLists(client, ctx?.lists),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

export function useAdjustQuantity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, delta, note }: { id: string; delta: number; note?: string }) =>
      getItemRepository().adjustQuantity(id, delta, note),
    onMutate: async ({ id, delta }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, quantity: Math.max(0, item.quantity + delta) }));
      return { lists };
    },
    onError: (_e, _v, ctx) => restoreLists(client, ctx?.lists),
    onSettled: (_d, _e, { id }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

export function useAdjustGauge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, adjustment }: { id: string; adjustment: GaugeAdjustment }) =>
      getItemRepository().adjustGauge(id, adjustment),
    onMutate: async ({ id, adjustment }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) =>
        item.gauge ? withGaugeNet(item, item.gauge.currentNetValue + adjustment.delta) : item,
      );
      return { lists };
    },
    onError: (_e, _v, ctx) => restoreLists(client, ctx?.lists),
    onSettled: (_d, _e, { id }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

export function useSoftDeleteItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      getItemRepository().softDelete(id, note),
    onMutate: async ({ id }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, isActive: false }));
      return { lists };
    },
    onError: (_e, _v, ctx) => restoreLists(client, ctx?.lists),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

export function useRestoreItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getItemRepository().restore(id),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.items() }),
  });
}

export function useHardDeleteItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getItemRepository().hardDelete(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/** Outcome of a bulk edit: how many of the selected items applied cleanly vs. errored. */
export interface BulkEditResult {
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Apply a {@link BulkEditSpec} to many selected items at once (Phase 76). Invalidation-based:
 * the write spans several fields across many items, which a single optimistic patch can't
 * cleanly express. Each item's changes route through the existing, already-tested repository
 * methods — `update` (category/condition), `move` (location), `restore`/`softDelete`
 * (active-state) and `TagRepository.setForItem` (tags) — so there is **no new write SQL**. A
 * per-item failure is counted, not fatal, so one bad row can't abort the whole batch.
 */
export function useBulkEditItems() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ids,
      spec,
    }: {
      ids: readonly string[];
      spec: BulkEditSpec;
    }): Promise<BulkEditResult> => {
      const items = getItemRepository();
      const tags = getTagRepository();
      let succeeded = 0;
      let failed = 0;
      for (const id of ids) {
        try {
          // Category + condition fold into one update; an absent field stays untouched.
          const patch: UpdateItemInput = {
            ...(spec.category ? { categoryId: spec.category.value } : {}),
            ...(spec.condition ? { condition: spec.condition.value } : {}),
          };
          if (Object.keys(patch).length > 0) await items.update(id, patch);

          if (spec.location) await items.move(id, spec.location.value);

          if (spec.active) {
            if (spec.active.value) await items.restore(id);
            else await items.softDelete(id);
          }

          if (spec.tags && spec.tags.names.length > 0) {
            const current = await tags.getForItem(id);
            const next = resolveItemTagNames(current.map((t) => t.name), spec.tags);
            await tags.setForItem(id, next);
          }
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
      return { succeeded, failed };
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/**
 * Duplicate an item (Phase 76) — seed a new item from an existing one (item-as-template). Reads
 * the source, plans the {@link planItemClone} create seed (template fields copied, per-instance
 * identity stripped, stock reset), creates the new item, then copies the source's operational
 * metadata, stored custom-field values and supplier parts onto the clone. Invalidation-based.
 */
export function useCloneItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId }: { sourceId: string }): Promise<Item> => {
      const itemsRepo = getItemRepository();
      const source = await itemsRepo.getById(sourceId);
      if (!source) throw new Error('The item to duplicate could not be found.');

      const seed = planItemClone(source);
      const created =
        source.trackingMode === 'SERIALISED'
          ? (await itemsRepo.createSerialised(seed))[0]
          : await itemsRepo.create(seed);
      if (!created) throw new Error('The duplicate could not be created.');

      // Operational metadata can't ride in a non-gauge CreateItemInput — copy it via update.
      if (source.operationalMetadata) {
        await itemsRepo.update(created.id, { operationalMetadata: source.operationalMetadata });
      }

      // Stored custom-field values (the clone keeps the same category, so they remain valid).
      const fields = await getCategoryRepository().resolveItemFields(sourceId);
      const values = clonedFieldValues(fields);
      if (Object.keys(values).length > 0) {
        await getCategoryRepository().setItemFieldValues(created.id, values);
      }

      // Supplier parts (preserving the preferred winner).
      const parts = await getSupplierPartRepository().listForItem(sourceId);
      for (const part of parts) {
        await getSupplierPartRepository().create(created.id, clonedSupplierPartInput(part));
      }

      return created;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

// --- Supplier-part mutations (§4 supplier facet; Phase 60) ----------------------
// Invalidation-based: the editable table is low-frequency and re-reads cheaply; a
// preferred-toggle also shifts row ordering, which a single optimistic patch can't express.

/** Invalidate an item's supplier-part list (and the item, since cost precedence may shift). */
function invalidateSupplierParts(client: QueryClient, itemId: string): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.itemSupplierParts(itemId) });
  void client.invalidateQueries({ queryKey: inventoryKeys.item(itemId) });
}

export function useCreateSupplierPart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: CreateSupplierPartInput }) =>
      getSupplierPartRepository().create(itemId, input),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useUpdateSupplierPart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; itemId: string; input: UpdateSupplierPartInput }) =>
      getSupplierPartRepository().update(id, input),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useSetPreferredSupplierPart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) =>
      getSupplierPartRepository().setPreferred(id),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useDeleteSupplierPart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) =>
      getSupplierPartRepository().delete(id),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

// --- Location mutations (invalidation-based; see file header) -------------------

export function useCreateLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLocationInput) => getLocationRepository().create(input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
  });
}

export function useUpdateLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLocationInput }) =>
      getLocationRepository().update(id, input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
  });
}

export function useDeleteLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getLocationRepository().delete(id),
    onSettled: () => {
      // A delete re-parents items to Unassigned, so refresh items too.
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

/** Drop keys whose value is `undefined` so an optimistic spread doesn't blank fields. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
