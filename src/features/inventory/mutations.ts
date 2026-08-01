/**
 * Tier-1 write hooks for the inventory domain (spec §2.1).
 *
 * Item mutations apply **optimistic updates with onError rollback** — the spec's
 * defence against UI tearing during rapid successive inputs (e.g. repeated gauge
 * or quantity adjustments queuing in OPFS). Each hook patches the affected item in
 * `onMutate`, and on failure **inverts that same patch** in `onError` (issue #300) —
 * reversing only its own contribution rather than restoring a whole-cache snapshot, so a
 * concurrent optimistic patch from an overlapping write in the same burst survives the
 * rollback. It reconciles with the worker in `onSettled` via targeted invalidation. A
 * rollback also **tells the user why** (issue #307) — see {@link useReportWriteFailure};
 * a revert that says nothing is indistinguishable from a UI glitch. The one failure it does
 * *not* roll back on is a database timeout, which proves nothing about whether the write
 * landed — see {@link undoItem} (issue #554).
 *
 * Location mutations reshape a tree whose optimistic mutation is error-prone and
 * low-frequency, so they use straightforward invalidation rather than optimistic
 * patching — a deliberate, scoped simplification.
 *
 * The invalidation-based hooks here (supplier parts, relations, test records, locations,
 * …) patch nothing, so a failure has nothing to roll back — but it must still be told, or
 * the write just appears to do nothing. They therefore carry the same {@link useReportWriteFailure}
 * `onError`, with the generic "could not be saved" fallback rather than the optimistic
 * "…has been undone" line (issue #389).
 */
import { useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { isUnknownWriteOutcome, useReportWriteFailure } from '@/features/errors';
import {
  getCategoryRepository,
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
import { activityKeys } from '@/features/activity/queries';
import { checkoutKeys } from '@/features/contacts/keys';
import { reportKeys } from '@/features/reports/keys';
import { inventoryKeys } from './queries';
import { resolveItemTagNames, type BulkEditSpec } from './bulk-edit';
import { clonedFieldValues, clonedSupplierPartInput, planItemClone } from './clone';
import { invalidateItems, invalidateItemStock } from './invalidate';

type ItemListData = InfiniteData<Page<Item>, number>;

/**
 * The rollback an optimistic hook hands `onError`: a patch that reverses **only this
 * mutation's** contribution to the cached item, applied through {@link patchItem}. Returning an
 * inverse patch rather than a captured snapshot is what lets a failure mid-burst leave a
 * concurrent write's still-valid optimistic patch in place (issue #300).
 */
type UndoContext = { undo: (item: Item) => Item };

/**
 * The `['inventory','items','list']` prefix an item-list key opens with, taken from the factory
 * rather than re-typed, so renaming a segment there can't silently stop this predicate matching
 * (issue #379). Read from a representative key: the filters object is the last segment, so the
 * prefix is everything before it.
 *
 * Read **when the predicate runs**, never at module scope: a couple of dozen component tests
 * replace `./queries` wholesale with a `vi.mock` factory listing only the hooks they render, so
 * reaching for the factory at import time would stop this module loading at all in them (the
 * same hazard `./invalidate` exists to avoid).
 */
function itemListPrefix(): readonly unknown[] {
  return inventoryKeys.itemList({}).slice(0, -1);
}

const itemListFilter = {
  // Match only the infinite list queries — exactly [...itemListPrefix(), filters].
  // The count query (…,'list',filters,'count') is one segment longer and holds a number,
  // so it must be excluded or the InfiniteData updater would crash on it.
  predicate: (query: { queryKey: readonly unknown[] }) => {
    const prefix = itemListPrefix();
    return (
      query.queryKey.length === prefix.length + 1 &&
      prefix.every((segment, i) => query.queryKey[i] === segment)
    );
  },
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

/**
 * Cancel every in-flight fetch {@link patchItem} is about to write over, so a resolving refetch
 * can't clobber the optimistic patch (issue #295).
 *
 * This must cover the **detail** query as well as the lists: an outstanding `useItem(id)` refetch
 * that is not cancelled resolves *after* `onMutate` has patched, and overwrites the optimistic
 * value with the pre-write one — the detail card visibly snaps back the moment the user taps ±.
 *
 * Cancellation is `exact` on purpose. `itemHistory(id)` is a *child* of the detail key, and an
 * item's Activity Log is not something this write patches — a prefix cancel would abort a
 * perfectly good history fetch alongside the one slice that needs it.
 */
async function cancelItemQueries(client: QueryClient, id: string): Promise<void> {
  await Promise.all([
    client.cancelQueries(itemListFilter),
    client.cancelQueries({ queryKey: inventoryKeys.item(id), exact: true }),
  ]);
}

/** Read the current cached copy of an item — the detail slice first, then any list page holds it. */
function readCachedItem(client: QueryClient, id: string): Item | undefined {
  const detail = client.getQueryData<Item>(inventoryKeys.item(id));
  if (detail) return detail;
  for (const [, data] of client.getQueriesData<ItemListData>(itemListFilter)) {
    const found = data?.pages.flatMap((page) => page.rows).find((row) => row.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Build a field-level inverse patch for a set-fields mutation (update / move / soft-delete):
 * capture the *current* value of each field the write is about to overwrite, and hand back a patch
 * that puts exactly those fields back. Restoring only the touched fields — not a whole snapshot —
 * leaves a concurrent write's patch to *other* fields untouched (issue #300).
 */
function invertFields(
  client: QueryClient,
  id: string,
  changes: Readonly<Record<string, unknown>>,
): (item: Item) => Item {
  const current = readCachedItem(client, id) as Record<string, unknown> | undefined;
  // The item wasn't cached when the patch went out, so `patchItem` touched nothing and there is
  // nothing to undo — an identity patch, never a spread of `undefined` that would blank the
  // captured fields should the item have re-entered the cache by the time the write fails.
  if (!current) return (item) => item;
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, current[key]])) as Partial<Item>;
  return (item) => ({ ...item, ...before });
}

/**
 * Apply an `onError` rollback: invert this mutation's own patch across the item's cache slices.
 *
 * **Unless the outcome is unknown** (issue #554). A rollback asserts the write did not happen, and
 * a `WORKER_TIMEOUT` does not establish that: nothing cancels a request that timed out, so the
 * worker may still be queued on it or mid-statement and commit it moments later. Inverting there
 * shows the user a value the very next read contradicts. The patch stays, and `onSettled`'s
 * invalidation — which runs whichever way the write went — is what settles it truthfully.
 */
function undoItem(client: QueryClient, id: string, ctx: UndoContext | undefined, error: unknown): void {
  if (isUnknownWriteOutcome(error)) return;
  if (ctx) patchItem(client, id, ctx.undo);
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
    onMutate: async ({ id, input }): Promise<UndoContext> => {
      await cancelItemQueries(client, id);
      const changes = stripUndefined(input);
      const undo = invertFields(client, id, changes);
      patchItem(client, id, (item) => ({ ...item, ...changes }));
      return { undo };
    },
    onError: (e, { id }, ctx) => {
      undoItem(client, id, ctx, e);
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
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.scrape', 'common.writeFailed');
  return useMutation({
    mutationFn: ({ id, write }: { id: string; write: ScrapeApplyInput }) =>
      getItemRepository().applyScrape(id, write),
    // The apply is fired without an error surface, so a rejected merge would otherwise vanish (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.revaluation',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordRevaluationInput }) =>
      getItemRepository().recordRevaluation(id, input),
    // Fired from the revaluation editor without an error surface — surface a rejected write (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.relationRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ relationId }: { relationId: string; fromItemId: string; toItemId: string }) =>
      getItemRepository().removeRelation(relationId),
    // Fired straight from the ✕ on a linked-item row with no error surface (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.testRecord',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RecordTestResultInput }) =>
      getItemRepository().recordTestResult(id, input),
    // The test-records editor announces only success, so a rejected write would go unheard (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.testRecordRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ recordId }: { recordId: string; itemId: string }) =>
      getItemRepository().removeTestRecord(recordId),
    // Fired from the ✕ on a test-record row with no error surface (#389).
    onError: reportFailure,
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
    onMutate: async ({ id, locationId }): Promise<UndoContext> => {
      await cancelItemQueries(client, id);
      const undo = invertFields(client, id, { locationId });
      patchItem(client, id, (item) => ({ ...item, locationId }));
      return { undo };
    },
    onError: (e, { id }, ctx) => {
      undoItem(client, id, ctx, e);
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
    onMutate: async ({ id, delta }): Promise<UndoContext> => {
      await cancelItemQueries(client, id);
      patchItem(client, id, (item) => ({ ...item, quantity: Math.max(0, item.quantity + delta) }));
      // Reverse this tap's own delta from the *current* value, not from a captured snapshot —
      // so a rejected tap mid-burst leaves the other taps' still-valid patches in place (#300).
      return { undo: (item) => ({ ...item, quantity: Math.max(0, item.quantity - delta) }) };
    },
    onError: (e, { id }, ctx) => {
      undoItem(client, id, ctx, e);
      reportFailure(e);
    },
    onSettled: (_d, _e, { id }) => {
      // Only the LAST tap of a rapid burst refetches the list. Each tap is optimistic and
      // its own write; if every settle invalidated, an earlier tap's refetch could resolve
      // before a later tap's write had landed and snap the displayed quantity back to a
      // stale value mid-burst. `isMutating === 1` means this is the only adjust still in
      // flight, i.e. the burst is over (TanStack's awaited-optimistic-update pattern).
      //
      // The narrow `invalidateItemStock` is correct here because this write moves nothing but
      // the item's stock level: the status counts it can change (low / out of stock) sit under
      // `items()` and are swept, while the six it cannot are left cached (issue #166).
      if (client.isMutating({ mutationKey: ADJUST_QUANTITY_KEY }) === 1) {
        invalidateItemStock(client);
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
    onMutate: async ({ id, adjustment }): Promise<UndoContext> => {
      await cancelItemQueries(client, id);
      patchItem(client, id, (item) =>
        item.gauge ? withGaugeNet(item, item.gauge.currentNetValue + adjustment.delta) : item,
      );
      // Reverse this adjust's own delta from the current net, mirroring the quantity path — a
      // rejected adjust mid-burst leaves overlapping adjusts' patches intact (#300).
      return {
        undo: (item) =>
          item.gauge ? withGaugeNet(item, item.gauge.currentNetValue - adjustment.delta) : item,
      };
    },
    onError: (e, { id }, ctx) => {
      undoItem(client, id, ctx, e);
      reportFailure(e);
    },
    onSettled: (_d, _e, { id }) => {
      // As with quantity: only the last of a rapid burst refetches, so an earlier tap's
      // refetch can't snap the gauge back to a stale value before a later write lands — and
      // likewise this moves only the gauge's stock level, so the narrow sweep applies (#166).
      if (client.isMutating({ mutationKey: ADJUST_GAUGE_KEY }) === 1) {
        invalidateItemStock(client);
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.gaugeConfig',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: GaugeConfigChange }) =>
      getItemRepository().reconfigureGauge(id, change),
    // The editor just flips its button back to "Saved", so a rejected reconfigure would be
    // invisible — surface the reason (a capacity/tare the repository refuses, the hard stop) (#389).
    onError: reportFailure,
    onSettled: (_d, _e, { id }) => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
    },
  });
}

/**
 * Clear one item's Activity Log (issue #620), leaving the single entry that records the
 * clear. Invalidation-based: the log is a read-only projection of the ledger, so there is
 * nothing to patch optimistically — and guessing at the marker entry the repository writes
 * would show copy that has not been saved yet.
 *
 * `clearedBy` is the label the marker entry names: the signed-in user, or the device when
 * the users module is off. The caller resolves it — the session lives in the UI, not here.
 *
 * No {@link useReportWriteFailure} here, unlike its invalidation-based neighbours (issue #389):
 * the clear is only reachable from a confirmation dialog that stays open and shows the failure
 * inline, so a toast on top would report the same failure twice. This is the same call the
 * tare-preset deletion makes, for the same reason.
 *
 * The global activity feed is swept too: it shows these same ledger rows, and unlike an
 * ordinary write (which only *adds* to it) a clear removes rows already on screen.
 */
export function useClearItemHistory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, clearedBy }: { id: string; clearedBy: string }) =>
      getItemRepository().clearHistory(id, clearedBy),
    onSettled: (_d, _e, { id }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(id) });
      void client.invalidateQueries({ queryKey: activityKeys.all });
    },
  });
}

export function useSoftDeleteItem() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.delete');
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => getItemRepository().softDelete(id, note),
    onMutate: async ({ id }): Promise<UndoContext> => {
      await cancelItemQueries(client, id);
      const undo = invertFields(client, id, { isActive: false });
      patchItem(client, id, (item) => ({ ...item, isActive: false }));
      return { undo };
    },
    onError: (e, { id }, ctx) => {
      undoItem(client, id, ctx, e);
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
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.restore', 'common.writeFailed');
  return useMutation({
    mutationFn: (id: string) => getItemRepository().restore(id),
    // Fired from the item's actions menu with no error surface — surface a rejected restore (#389).
    onError: reportFailure,
    onSettled: () => {
      invalidateItems(client);
      // Restoring puts the item back into its location's count, exactly as soft-deleting took
      // it out — so the sidebar tree needs the same refresh the delete already asked for.
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
      // No `originDeviceId` (W1g): a clone copies strings rather than authoring them, so it
      // makes no claim about where a `FILE` path would resolve — the copy lands unattributed,
      // exactly as a value written before the column existed does. Stamping *this* device would
      // be the one clearly wrong answer, since cloning a desktop path on a phone would then
      // assert the phone can reach it.
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.supplierPartAdd',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: CreateSupplierPartInput }) =>
      getSupplierPartRepository().create(itemId, input),
    // The supplier-parts table fires its edits without an error surface (#389).
    onError: reportFailure,
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useUpdateSupplierPart() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.supplierPartUpdate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, input }: { id: string; itemId: string; input: UpdateSupplierPartInput }) =>
      getSupplierPartRepository().update(id, input),
    onError: reportFailure,
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useSetPreferredSupplierPart() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.supplierPreferred',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) => getSupplierPartRepository().setPreferred(id),
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.priceSource',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, itemId, on }: { id: string; itemId: string; on: boolean }) =>
      on
        ? getSupplierPartRepository().setPriceSource(id)
        : getSupplierPartRepository().clearPriceSource(itemId),
    onError: reportFailure,
    onSettled: (_d, _e, { itemId }) => invalidateSupplierParts(client, itemId),
  });
}

export function useDeleteSupplierPart() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.supplierPartRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) => getSupplierPartRepository().delete(id),
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.locationCreate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: CreateLocationInput) => getLocationRepository().createPath(input),
    // The create dialog fires with only an `onSuccess`, so a rejected create would close the
    // flow saying nothing — surface the reason (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.locationArchive',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      getLocationRepository().setArchived(id, archived),
    // Fired from the location's menu with no error surface (#389).
    onError: reportFailure,
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
  });
}

export function useDeleteLocation() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.locationDelete',
    'common.writeFailed',
  );
  return useMutation({
    // The delete itself returns every tool still out to this location first (restoring
    // stock/history as a normal check-in would) so it never silently strands stock marked
    // "out" (B4) — in the *same* transaction, so the returns can't survive a failed delete
    // (issue #301). The location's `ON DELETE CASCADE` on the borrower `location_id` then
    // removes the returned checkout rows. (This is the loan *target*; the delete's own SQL
    // still nulls the distinct source_location_id.)
    mutationFn: (id: string) => getLocationRepository().delete(id),
    // The sidebar fires the delete with only an `onSuccess`, so a rejected delete would be
    // silent — surface the reason (#389).
    onError: reportFailure,
    onSettled: () => {
      // A delete re-parents items to Unassigned, so refresh items too.
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: checkoutKeys.all });
    },
  });
}

/** Drop keys whose value is `undefined` so an optimistic spread doesn't blank fields. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}
