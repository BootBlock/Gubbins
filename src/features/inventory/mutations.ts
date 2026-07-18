/**
 * Tier-1 write hooks for the inventory domain (spec §2.1).
 *
 * Item mutations apply **optimistic updates with onError rollback** — the spec's
 * defence against UI tearing during rapid successive inputs (e.g. repeated gauge
 * or quantity adjustments queuing in OPFS). Each hook snapshots the affected cache
 * slices in `onMutate`, patches them immediately, restores them in `onError`, and
 * reconciles with the worker in `onSettled` via targeted invalidation. A rollback also
 * **tells the user why** (issue #307) — see {@link useReportWriteFailure}; a revert that
 * says nothing is indistinguishable from a UI glitch.
 *
 * Location mutations reshape a tree whose optimistic mutation is error-prone and
 * low-frequency, so they use straightforward invalidation rather than optimistic
 * patching — a deliberate, scoped simplification.
 */
import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
// Imported from the subpath, not the `@/components/foundry` barrel: the barrel re-exports
// components that import back into `@/features/inventory` and `@/features/command-palette`
// (which imports this very module), so the barrel would close a module cycle here — and it
// would drag Modal/Menu/Markdown/RegionCanvas into every chunk that writes an item.
import { useOptionalToast } from '@/components/foundry/toast';
import { useT, type MessageKey } from '@/features/i18n';
import { DbError } from '@/db/errors';
import {
  getCategoryRepository,
  getCheckoutRepository,
  getItemRepository,
  getLocationRepository,
  getSupplierPartRepository,
  getTagRepository,
  type CreateItemInput,
  type CreateLocationInput,
  type CreateSupplierPartInput,
  type AddRelationInput,
  type GaugeAdjustment,
  type Item,
  type Page,
  type RecordRevaluationInput,
  type RecordTestResultInput,
  type ScrapeApplyInput,
  type UpdateItemInput,
  type UpdateLocationInput,
  type UpdateSupplierPartInput,
} from '@/db/repositories';
import { currentGrossWeight, percentageRemaining, type GaugeConfigChange } from '@/db/repositories/gauge';
import { reportKeys } from '@/features/reports/keys';
import { inventoryKeys } from './queries';
import { resolveItemTagNames, type BulkEditSpec } from './bulk-edit';
import { clonedFieldValues, clonedSupplierPartInput, planItemClone } from './clone';
import { invalidateItems } from './invalidate';

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
  client.setQueryData<Item | undefined>(inventoryKeys.item(id), (item) => (item ? patch(item) : item));
}

/** Cancel in-flight list fetches and snapshot them so onError can restore. */
async function snapshotLists(client: QueryClient): Promise<ListSnapshot> {
  await client.cancelQueries(itemListFilter);
  return client.getQueriesData<ItemListData>(itemListFilter);
}

function restoreLists(client: QueryClient, snapshot: ListSnapshot | undefined): void {
  snapshot?.forEach(([key, data]) => client.setQueryData(key, data));
}

/**
 * The heading each optimistic write shows when its rollback fires (issue #307). Derived from the
 * catalog rather than hand-listed, so a new heading is one `en.json`/`de.json` key, not three edits.
 */
type WriteFailureKey = Extract<MessageKey, `inventory.writeError.heading.${string}`>;

/**
 * How long an identical failure is swallowed before it is reported again (rapid-tap coalescing).
 * Roughly a toast's own dwell time, so a burst reads as one message rather than a stack.
 */
const WRITE_FAILURE_REPEAT_MS = 3_000;

/**
 * Report a rolled-back optimistic write to the user (issue #307).
 *
 * An optimistic patch that silently reverts reads as a UI glitch — the item vanishes and
 * reappears, the star un-stars itself, the gauge snaps back — so the rational response is to
 * try again, against a write that is failing for a reason (a constraint violation, the storage
 * hard stop, `SQLITE_BUSY`) that would have been actionable had it been shown. The report
 * therefore lives **here**, beside the rollback it explains, rather than at each of the ~20
 * call sites: a `.mutate()` with no `onError` of its own still tells the user.
 *
 * A {@link DbError} carries a message written for the user (the storage hard stop, a constraint
 * the repository names), so that becomes the toast body — it is the actionable part. Anything
 * else is an internal failure whose text is not user-facing copy and would not be translated, so
 * it degrades to the generic "undone" line rather than putting raw SQL in front of the user. This
 * mirrors how the stock-transfer toast already picks its message. A call site that wants a more
 * specific message can still add its own `onError` — but it no longer has to.
 */
function useReportWriteFailure(key: WriteFailureKey): (error: unknown) => void {
  // Optional: these hooks are exercised by harnesses that render without a ToastProvider, and a
  // failed write must not become a crash on top of a failed write.
  const toast = useOptionalToast();
  const t = useT();
  // The last failure this hook instance reported, so a burst coalesces (see below).
  const lastReport = useRef<{ signature: string; at: number } | null>(null);
  return useCallback(
    (error: unknown) => {
      const detail = error instanceof DbError ? error.message.trim() : '';
      const signature = `${key} ${detail}`;
      const now = Date.now();

      // Quantity and gauge adjusts are explicitly rapid-tap (see the de-bounce in their
      // `onSettled`), so a persistent failure would otherwise stack one identical toast per tap
      // and announce it once per tap to assistive tech. Report the first, then swallow identical
      // repeats for a short window. The window is deliberately not extended on a swallowed
      // repeat, so an ongoing problem re-surfaces rather than going quiet after one message.
      const last = lastReport.current;
      if (last && last.signature === signature && now - last.at < WRITE_FAILURE_REPEAT_MS) return;
      lastReport.current = { signature, at: now };

      toast?.show({
        tone: 'danger',
        heading: t(key),
        message: detail || t('inventory.writeError.reverted'),
      });
    },
    [toast, t, key],
  );
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
      invalidateItems(client);
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
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

export function useUpdateItem() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.update');
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateItemInput }) =>
      getItemRepository().update(id, input),
    onMutate: async ({ id, input }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, ...stripUndefined(input) }));
      return { lists };
    },
    onError: (e, _v, ctx) => {
      restoreLists(client, ctx?.lists);
      reportFailure(e);
    },
    onSettled: (_d, _e, { id }) => {
      invalidateItems(client);
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
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.item(id) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/**
 * Record a manual revaluation of an item (feature-gap G9) — append a value point to the
 * revaluation log and set the item's live `current_value`. Invalidation-based: the write
 * touches the item, its revaluation log and the Activity Ledger together, so a targeted
 * refresh of those slices is simpler than an optimistic patch. Invalidating `items()` also
 * refreshes the valuation reports/schedule that now value through the manual current value.
 */
export function useRecordRevaluation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordRevaluationInput }) =>
      getItemRepository().recordRevaluation(id, input),
    onSettled: (_d, _e, { id }) => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.item(id) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemRevaluations(id) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/**
 * Add a related-items cross-link (feature-gap G6). A relation is reciprocal, so it changes what
 * BOTH endpoints show — invalidate each item's relations slice (the `from`/`to` pair). Deliberately
 * invalidation-based (not optimistic): the write is low-frequency and validates/canonicalises in the
 * repository, so a targeted refresh is simpler than patching a derived, resolved list.
 */
export function useAddRelation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddRelationInput) => getItemRepository().addRelation(input),
    onSettled: (_d, _e, input) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemRelations(input.fromItemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemRelations(input.toItemId) });
    },
  });
}

/**
 * Remove a related-items cross-link (feature-gap G6). The relation id encodes its endpoints, so the
 * caller passes them alongside so both items' relations slices refresh (the removed link showed on
 * each).
 */
export function useRemoveRelation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ relationId }: { relationId: string; fromItemId: string; toItemId: string }) =>
      getItemRepository().removeRelation(relationId),
    onSettled: (_d, _e, { fromItemId, toItemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemRelations(fromItemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemRelations(toItemId) });
    },
  });
}

/**
 * Record a test / calibration / service result against an item (feature-gap G7) — append a
 * `test_records` row + a `TESTED` Activity-Ledger entry. Invalidation-based: the write touches the
 * item's test-records slice and its Activity Log together (plus `items()` so any timeline/feed
 * reflects the new event), so a targeted refresh is simpler than an optimistic patch.
 */
export function useRecordTestResult() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordTestResultInput }) =>
      getItemRepository().recordTestResult(id, input),
    onSettled: (_d, _e, { id }) => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.itemTestRecords(id) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/**
 * Remove a mistaken test record (feature-gap G7). The caller passes the owning `itemId` alongside
 * the record id so its test-records slice refreshes (a record shows only on its own item).
 */
export function useRemoveTestRecord() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId }: { recordId: string; itemId: string }) =>
      getItemRepository().removeTestRecord(recordId),
    onSettled: (_d, _e, { itemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemTestRecords(itemId) });
    },
  });
}

export function useMoveItem() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.move');
  return useMutation({
    mutationFn: ({ id, locationId }: { id: string; locationId: string }) =>
      getItemRepository().move(id, locationId),
    onMutate: async ({ id, locationId }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, locationId }));
      return { lists };
    },
    onError: (e, _v, ctx) => {
      restoreLists(client, ctx?.lists);
      reportFailure(e);
    },
    onSettled: () => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/** Mutation key used to count in-flight quantity adjusts (rapid-tap de-bounce, see below). */
const ADJUST_QUANTITY_KEY = ['inventory', 'adjust-quantity'] as const;

export function useAdjustQuantity() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.quantity');
  return useMutation({
    mutationKey: ADJUST_QUANTITY_KEY,
    mutationFn: ({ id, delta, note }: { id: string; delta: number; note?: string }) =>
      getItemRepository().adjustQuantity(id, delta, note),
    onMutate: async ({ id, delta }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, quantity: Math.max(0, item.quantity + delta) }));
      return { lists };
    },
    onError: (e, _v, ctx) => {
      restoreLists(client, ctx?.lists);
      reportFailure(e);
    },
    onSettled: (_d, _e, { id }) => {
      // Only the LAST tap of a rapid burst refetches the list. Each tap is optimistic and
      // its own write; if every settle invalidated, an earlier tap's refetch could resolve
      // before a later tap's write had landed and snap the displayed quantity back to a
      // stale value mid-burst. `isMutating === 1` means this is the only adjust still in
      // flight, i.e. the burst is over (TanStack's awaited-optimistic-update pattern).
      if (client.isMutating({ mutationKey: ADJUST_QUANTITY_KEY }) === 1) {
        invalidateItems(client);
      }
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/** Mutation key used to count in-flight gauge adjusts (rapid-tap de-bounce). */
const ADJUST_GAUGE_KEY = ['inventory', 'adjust-gauge'] as const;

export function useAdjustGauge() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.gauge');
  return useMutation({
    mutationKey: ADJUST_GAUGE_KEY,
    mutationFn: ({ id, adjustment }: { id: string; adjustment: GaugeAdjustment }) =>
      getItemRepository().adjustGauge(id, adjustment),
    onMutate: async ({ id, adjustment }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) =>
        item.gauge ? withGaugeNet(item, item.gauge.currentNetValue + adjustment.delta) : item,
      );
      return { lists };
    },
    onError: (e, _v, ctx) => {
      restoreLists(client, ctx?.lists);
      reportFailure(e);
    },
    onSettled: (_d, _e, { id }) => {
      // As with quantity: only the last of a rapid burst refetches, so an earlier tap's
      // refetch can't snap the gauge back to a stale value before a later write lands.
      if (client.isMutating({ mutationKey: ADJUST_GAUGE_KEY }) === 1) {
        invalidateItems(client);
      }
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/**
 * Correct a gauge's unit / capacity / tare (issue #69). Unlike `useAdjustGauge` this is a
 * deliberate, one-at-a-time configuration edit rather than a rapid-tap stock movement, so
 * it takes the straightforward invalidate-on-settle path with no optimistic patching — a
 * capacity shrink can also spill material, and the clamped result is the repository's to
 * decide, not something the cache should guess at.
 */
export function useReconfigureGauge() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: GaugeConfigChange }) =>
      getItemRepository().reconfigureGauge(id, change),
    onSettled: (_d, _e, { id }) => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

export function useSoftDeleteItem() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.delete');
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => getItemRepository().softDelete(id, note),
    onMutate: async ({ id }) => {
      const lists = await snapshotLists(client);
      patchItem(client, id, (item) => ({ ...item, isActive: false }));
      return { lists };
    },
    onError: (e, _v, ctx) => {
      restoreLists(client, ctx?.lists);
      reportFailure(e);
    },
    onSettled: () => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

export function useRestoreItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getItemRepository().restore(id),
    onSettled: () => invalidateItems(client),
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
            const next = resolveItemTagNames(
              current.map((t) => t.name),
              spec.tags,
            );
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
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/**
 * Duplicate an item (Phase 76) — seed a new item from an existing one (item-as-template). Reads
 * the source, plans the {@link planItemClone} create seed (template fields copied, per-instance
 * identity stripped, stock reset), creates the new item, then copies the source's operational
 * metadata, stored custom-field values and supplier parts onto the clone. Invalidation-based.
 *
 * **Best-effort, not atomic.** The create and the follow-up child copies are separate
 * transactions (they span several repositories), so a failure partway through can leave a
 * created-but-partially-populated clone in the inventory. That is an acceptable trade-off here —
 * the clone is a convenience seed the user edits anyway, and a stray copy is easily soft-deleted —
 * rather than introducing a cross-repository transaction. The caller surfaces the failure.
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
      invalidateItems(client);
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
    mutationFn: ({ id }: { id: string; itemId: string }) => getSupplierPartRepository().setPreferred(id),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

/**
 * Toggle an item's pinned **price source** (issue #28): `on` pins this supplier as the single
 * source a refresh fetches (clearing any other); `off` clears the pin so a refresh again fetches
 * every supplier and reports the cheapest. Independent of the preferred (valuation) star.
 */
export function useSetSupplierPriceSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, on }: { id: string; itemId: string; on: boolean }) =>
      on
        ? getSupplierPartRepository().setPriceSource(id)
        : getSupplierPartRepository().clearPriceSource(itemId),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useDeleteSupplierPart() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) => getSupplierPartRepository().delete(id),
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

// --- Location mutations (invalidation-based; see file header) -------------------

/**
 * Create a whole branch of locations in one go from the nested-create shortcut (spec §4):
 * `/` or `\` nests levels *down* the tree and a `,` at the leaf fans *across* into siblings,
 * creating any missing ancestor levels and reusing the ones that already exist. See
 * {@link LocationRepository.createPath}. Resolves with the created/resolved leaves (in order),
 * so the inline "New location…" flow can select the first. A separator-free name creates a
 * single leaf, so this one hook serves both the nested and the flat case, and is what the
 * create dialog uses.
 */
export function useCreateLocationPath() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLocationInput) => getLocationRepository().createPath(input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
  });
}

export function useUpdateLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLocationInput }) =>
      getLocationRepository().update(id, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      // A location carries the dead-stock opt-in and idle threshold for everything inside
      // it (issue #92), so editing one re-shapes the dead-stock report. No item row changes,
      // so this is the one write that wants the reports prefix without `invalidateItems`.
      void client.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

/** Soft-archive a location (hide it) or restore it — a light wrapper over the repo. */
export function useArchiveLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      getLocationRepository().setArchived(id, archived),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
  });
}

export function useDeleteLocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      // Return every tool still out to this location first (restoring stock/history as a normal
      // check-in would) so deleting the location never silently strands stock still marked
      // "out" (B4) — mirroring the contact-delete flow. The location's `ON DELETE CASCADE` on
      // the borrower `location_id` then removes the now-returned checkout rows. (This is the
      // loan *target*; the delete's own SQL still nulls the distinct source_location_id.)
      await getCheckoutRepository().checkInAllForTarget('location', id);
      await getLocationRepository().delete(id);
    },
    onSettled: () => {
      // A delete re-parents items to Unassigned, so refresh items too.
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: ['checkouts'] });
    },
  });
}

/** Drop keys whose value is `undefined` so an optimistic spread doesn't blank fields. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}
