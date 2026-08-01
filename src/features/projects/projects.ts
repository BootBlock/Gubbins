/**
 * Tier-1 hooks for the projects domain (spec §2.1, §4 Projects & BOMs).
 *
 * Reads go through TanStack Query; writes use targeted invalidation (project edits
 * are low-frequency and reshape derived counts/costing/shopping-list aggregates, so
 * invalidation is simpler and safer than optimistic patching here — the same
 * deliberate split the category/tag hooks use). A project's BOM, costing and
 * shopping list are bounded per-project sets, fetched whole rather than virtualised;
 * the strict-pagination mandate (§2.1) targets the 100k+ item list.
 *
 * "Fetched whole" is enforced through {@link readAllPages} rather than assumed: the repository
 * clamps every read to `MAX_PAGE_SIZE`, so a lone `{ limit: 100 }` (or a `{ limit: 200 }` that
 * silently clamps to 100) quietly dropped part of a long BOM or expense ledger — and the BOM
 * feeds the export, where a short read is a wrong file rather than a shorter screen (issue #149).
 * The project *list* itself is a browse list and pages server-side instead.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getItemRepository,
  getProjectRepository,
  MAX_PAGE_SIZE,
  type CostingMode,
  type CreateBomLineInput,
  type CreateBudgetCategoryInput,
  type CreateExpenseInput,
  type CreateProjectInput,
  type FinaliseAssemblyInput,
  type ProcurementStatus,
  type ProjectFilter,
  type ProjectListParams,
  type ReservationStatus,
  type UpdateBomLineInput,
  type UpdateBudgetCategoryInput,
  type UpdateExpenseInput,
  type UpdateProjectInput,
} from '@/db/repositories';
import { checkoutKeys } from '@/features/contacts/keys';
import { useReportWriteFailure } from '@/features/errors';
import { inventoryKeys } from '@/features/inventory/queries';
import { readAllPages } from '@/lib/read-all-pages';
import type { ParsedBomLine } from './bom-import';
import { invalidateItems } from '@/features/inventory/invalidate';

/**
 * How the Projects master list is narrowed and ordered (issue #137) — the filter plus the sort,
 * with the page supplied separately. Named rather than inlined because it is both a query-key
 * fragment and the screen's own state shape.
 */
export type ProjectBrowse = Omit<ProjectListParams, 'limit' | 'offset'>;

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  /**
   * One page of the project list, for one filter and ordering. Nested **under**
   * {@link projectKeys.list} so every existing `invalidateQueries({ queryKey: projectKeys.list() })`
   * still refreshes every page, filter and count without each write having to learn about
   * pagination — or about the master list's search box.
   */
  page: (offset: number, limit: number, browse: ProjectBrowse = {}) =>
    [...projectKeys.list(), { offset, limit, ...browse }] as const,
  count: (filter: ProjectFilter = {}) => [...projectKeys.list(), 'count', filter] as const,
  budgetAlerts: () => [...projectKeys.all, 'budget-alerts'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
  lines: (id: string) => [...projectKeys.detail(id), 'lines'] as const,
  costing: (id: string) => [...projectKeys.detail(id), 'costing'] as const,
  shoppingList: (id: string) => [...projectKeys.detail(id), 'shopping-list'] as const,
  pickList: (id: string) => [...projectKeys.detail(id), 'pick-list'] as const,
  assemblyPreview: (id: string) => [...projectKeys.detail(id), 'assembly-preview'] as const,
  budget: (id: string) => [...projectKeys.detail(id), 'budget'] as const,
  expenses: (id: string) => [...projectKeys.detail(id), 'expenses'] as const,
  budgetCategories: (id: string) => [...projectKeys.detail(id), 'budget-categories'] as const,
} as const;

// --- reads ---------------------------------------------------------------------

/**
 * One page of the project list, optionally narrowed and re-ordered (issues #149, #137).
 *
 * Defaults to the first full page in the default order, which is exactly what every picker and
 * dashboard caller read before — only the Projects master list passes a page or a `browse`, so
 * nothing else changes shape. The filter is resolved by the database rather than applied to the
 * page in hand, so searching reaches projects that sort past the current page. Pair with
 * {@link useProjectCount} — given the same filter — wherever the whole set has to be reachable.
 */
export function useProjects(page = 1, pageSize = MAX_PAGE_SIZE, browse: ProjectBrowse = {}) {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize)));
  const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * limit);
  return useQuery({
    queryKey: projectKeys.page(offset, limit, browse),
    queryFn: () => getProjectRepository().list({ ...browse, limit, offset }),
    // Hold the previous page on screen while the next one loads (or the filter changes), so
    // paging and typing don't flash the empty state (the Tags screen's behaviour).
    placeholderData: (previous) => previous,
  });
}

/**
 * How many projects match `filter` — the denominator for the master list's pager, and the figure
 * the screen announces. Held through a filter change by the placeholder so the page strip
 * doesn't flicker between counts as the search box is typed into.
 */
export function useProjectCount(filter: ProjectFilter = {}) {
  return useQuery({
    queryKey: projectKeys.count(filter),
    queryFn: () => getProjectRepository().count(filter),
    placeholderData: (previous) => previous,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ''),
    queryFn: () => getProjectRepository().getById(id!),
    enabled: Boolean(id),
  });
}

/**
 * The project's **whole** bill of materials, in declared order (issue #149).
 *
 * Every line, not the first hundred: the BOM table, the "Finalise assembly" step and the BOM
 * export all read these rows, so a capped read didn't shorten a list — it produced a bill of
 * materials that was missing parts and an exported file that was quietly incomplete. `truncated`
 * is only ever true at the {@link readAllPages} safety ceiling, and the screen says so.
 */
export function useBomLines(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.lines(projectId ?? ''),
    queryFn: () => readAllPages((params) => getProjectRepository().listLines(projectId!, params)),
    enabled: Boolean(projectId),
  });
}

export function useProjectCosting(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.costing(projectId ?? ''),
    queryFn: () => getProjectRepository().getCosting(projectId!),
    enabled: Boolean(projectId),
  });
}

export function useShoppingList(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.shoppingList(projectId ?? ''),
    queryFn: () => getProjectRepository().getShoppingList(projectId!),
    enabled: Boolean(projectId),
  });
}

/**
 * The location-aware picking worksheet (issue #121): every BOM line paired with where its
 * matched item's stock physically sits. Depends on both the BOM lines and the `item_stock`
 * ledger, so it is invalidated by picking toggles and by any stock movement (receive,
 * reservation, assembly) — see the writes below.
 */
export function usePickList(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.pickList(projectId ?? ''),
    queryFn: () => getProjectRepository().listPickList(projectId!),
    enabled: Boolean(projectId),
  });
}

/**
 * What finalising the project would take from each matched part (issue #647) — the summary the
 * finalise dialog shows before an un-undoable button is pressed.
 *
 * Gated by `enabled` so it is only read while that dialog is open, and deliberately **never
 * stale-cached**: it reflects live stock, which any other screen can move without touching a
 * project key, so the app-wide 30-second `staleTime` would happily re-show figures a transfer had
 * already invalidated. A promise about an un-undoable action is worth one extra read, so it is
 * refetched every time the dialog opens. It is the same plan the finalise itself runs on, so what
 * the dialog promises and what the ledger records cannot disagree.
 */
export function useAssemblyPreview(projectId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: projectKeys.assemblyPreview(projectId ?? ''),
    queryFn: () => getProjectRepository().previewAssembly(projectId!),
    enabled: Boolean(projectId) && enabled,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

// --- budgeting reads (spec §4 budgeting) ---------------------------------------

/** Raw budget aggregates for a project; pair with the pure `summariseBudget`. */
export function useProjectBudget(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.budget(projectId ?? ''),
    queryFn: () => getProjectRepository().getBudget(projectId!),
    enabled: Boolean(projectId),
  });
}

/**
 * The project's manual expense ledger, fetched whole (bounded per-project).
 *
 * It asked for `{ limit: 200 }` before, which the repository clamped straight back to 100 — so
 * "fetched whole" was only ever true of a short ledger, and a longer one lost its oldest
 * entries without a word (issue #149).
 */
export function useExpenses(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.expenses(projectId ?? ''),
    queryFn: () => readAllPages((params) => getProjectRepository().listExpenses(projectId!, params)),
    enabled: Boolean(projectId),
  });
}

/** The project's budget categories (sub-budgets). */
export function useBudgetCategories(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.budgetCategories(projectId ?? ''),
    queryFn: () => getProjectRepository().listBudgetCategories(projectId!),
    enabled: Boolean(projectId),
  });
}

/**
 * Cross-project budget headlines for the dashboard "Budget alerts" widget. Pass
 * `{ enabled: false }` to mount the hook without fetching — the Dashboard nav tile gates it so
 * the over-budget count query only runs when that metric is the tile's current choice (A2).
 */
export function useBudgetAlerts(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: projectKeys.budgetAlerts(),
    queryFn: () => getProjectRepository().listBudgetAlerts(),
    enabled: options.enabled ?? true,
  });
}

// --- write helpers -------------------------------------------------------------

/**
 * Invalidate every derived view of a single project (lines, costing, shopping, budget).
 *
 * Returns the settled refetch so an `onSettled` that awaits it keeps the mutation `pending`
 * until the fresh rows have landed (issue #303). A guard that lifts the moment the write
 * resolves still exposes the caller to stale props — the BOM row would re-enable its actions
 * while `receivedQty` and the outstanding remainder are a refetch behind.
 */
function invalidateProject(client: ReturnType<typeof useQueryClient>, projectId: string): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: projectKeys.detail(projectId) }),
    client.invalidateQueries({ queryKey: projectKeys.list() }),
    // Budget figures feed the cross-project dashboard alerts feed too.
    client.invalidateQueries({ queryKey: projectKeys.budgetAlerts() }),
  ]).then(() => undefined);
}

// --- projects ------------------------------------------------------------------

export function useCreateProject() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.projectCreate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: CreateProjectInput) => getProjectRepository().create(input),
    // Surface a rejected create rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => void client.invalidateQueries({ queryKey: projectKeys.list() }),
  });
}

export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateProjectInput }) =>
      getProjectRepository().update(id, input),
    onSettled: (_data, _err, vars) => invalidateProject(client, vars.id),
  });
}

export function useSetCostingMode() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.costingMode',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: CostingMode }) =>
      getProjectRepository().setCostingMode(id, mode),
    // Surface a rejected costing-mode change rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: (_data, _err, vars) => invalidateProject(client, vars.id),
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    // The delete itself returns every tool still out on this project first (restoring
    // stock/history as a normal check-in would) so it never silently strands stock marked
    // "out" (B4) — in the *same* transaction, so the returns can't survive a failed delete
    // (issue #301). The project's `ON DELETE CASCADE` then removes the returned checkout rows.
    mutationFn: (id: string) => getProjectRepository().delete(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: projectKeys.list() });
      void client.invalidateQueries({ queryKey: projectKeys.budgetAlerts() });
      // A returned loan restores stock and closes checkout rows — refresh those views too.
      void client.invalidateQueries({ queryKey: checkoutKeys.all });
      invalidateItems(client);
    },
  });
}

// --- budgeting writes (spec §4 budgeting) --------------------------------------

export function useSetBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, budget }: { id: string; budget: number | null }) =>
      getProjectRepository().setBudget(id, budget),
    onSettled: (_data, _err, vars) => invalidateProject(client, vars.id),
  });
}

export function useAddExpense(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) => getProjectRepository().addExpense(projectId, input),
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useUpdateExpense(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ expenseId, input }: { expenseId: string; input: UpdateExpenseInput }) =>
      getProjectRepository().updateExpense(expenseId, input),
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useRemoveExpense(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.expenseRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (expenseId: string) => getProjectRepository().removeExpense(expenseId),
    // Surface a rejected expense removal rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useAddBudgetCategory(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.budgetCategoryAdd',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: CreateBudgetCategoryInput) =>
      getProjectRepository().addBudgetCategory(projectId, input),
    // Surface a rejected budget-category add rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useUpdateBudgetCategory(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, input }: { categoryId: string; input: UpdateBudgetCategoryInput }) =>
      getProjectRepository().updateBudgetCategory(categoryId, input),
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useRemoveBudgetCategory(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.budgetCategoryRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (categoryId: string) => getProjectRepository().removeBudgetCategory(categoryId),
    // Surface a rejected budget-category removal rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => invalidateProject(client, projectId),
  });
}

// --- BOM lines -----------------------------------------------------------------

export function useAddBomLine(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('projects.writeError.heading.bomLineAdd', 'common.writeFailed');
  return useMutation({
    mutationFn: (input: CreateBomLineInput) => getProjectRepository().addLine(projectId, input),
    // Surface a rejected BOM-line add rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => invalidateProject(client, projectId),
  });
}

/**
 * Add an existing inventory item to a project chosen at submit time — the item-centric entry
 * point (from the item card's actions) onto the very same `addLine` write path as
 * {@link useAddBomLine}, but with the project supplied per-call rather than bound to the hook.
 * Invalidates the chosen project's derived views (lines, costing, shopping list, budget).
 */
export function useAddItemToProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: CreateBomLineInput }) =>
      getProjectRepository().addLine(projectId, input),
    onSettled: (_data, _err, vars) => invalidateProject(client, vars.projectId),
  });
}

export function useUpdateBomLine(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, input }: { lineId: string; input: UpdateBomLineInput }) =>
      getProjectRepository().updateLine(lineId, input),
    onSettled: () => invalidateProject(client, projectId),
  });
}

export function useRemoveBomLine(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.bomLineRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (lineId: string) => getProjectRepository().removeLine(lineId),
    // Surface a rejected BOM-line removal rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => invalidateProject(client, projectId),
  });
}

// --- picking (issue #121 location-aware gather-and-tick) -----------------------

/**
 * Tick a BOM line as physically gathered (or clear it) during the picking pass. Picking
 * only flips the line's `picked` flag — it moves no stock and reshapes no cost, budget or
 * shopping figure — so it refreshes just the worksheet and the BOM lines (which carry the
 * flag), not the whole project detail or any inventory view.
 */
export function useSetPicked(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('projects.writeError.heading.picked', 'common.writeFailed');
  return useMutation({
    mutationFn: ({ lineId, picked }: { lineId: string; picked: boolean }) =>
      getProjectRepository().setPicked(lineId, picked),
    // Surface a rejected pick toggle rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: projectKeys.pickList(projectId) });
      void client.invalidateQueries({ queryKey: projectKeys.lines(projectId) });
    },
  });
}

// --- reservations & procurement ------------------------------------------------

export function useSetReservation(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.reservation',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ lineId, status, qty }: { lineId: string; status: ReservationStatus; qty?: number }) =>
      getProjectRepository().setReservation(lineId, status, qty),
    // Surface a rejected reservation change rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: (_data, _err, vars) => {
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(vars.lineId) });
      // Awaited: the row's controls stay locked until the refreshed line lands (issue #303).
      return invalidateProject(client, projectId);
    },
  });
}

export function useSetProcurement(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.procurement',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ lineId, status }: { lineId: string; status: ProcurementStatus }) =>
      getProjectRepository().setProcurement(lineId, status),
    // Surface a rejected procurement change rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => {
      invalidateItems(client);
      // Refresh the dashboard "arriving" feed and per-item incoming totals (Phase 20).
      void client.invalidateQueries({ queryKey: inventoryKeys.inTransit() });
      // Awaited: the row's controls stay locked until the refreshed line lands (issue #303).
      return invalidateProject(client, projectId);
    },
  });
}

export function useReceiveLine(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.receiveLine',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({
      lineId,
      locationId,
      quantity,
      batch,
    }: {
      lineId: string;
      locationId?: string;
      quantity?: number;
      batch?: { batchNumber: string | null; lotNumber: string | null; expiryDate: number | null };
    }) => getProjectRepository().receiveLine(lineId, { locationId, quantity, batch }),
    // Surface a rejected receive rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => {
      invalidateItems(client);
      // Received stock leaves the "arriving" feed and the item's incoming total (Phase 20).
      void client.invalidateQueries({ queryKey: inventoryKeys.inTransit() });
      // Awaited: the receive control stays locked until the refreshed line lands, so the
      // outstanding remainder it re-seeds from is never a refetch behind (issue #303).
      return invalidateProject(client, projectId);
    },
  });
}

// --- BOM import (spec §4 CSV/KiCad ingress with MPN/alias auto-match) -----------

export interface BomImportSummary {
  readonly added: number;
  readonly matched: number;
}

/**
 * Import parsed BOM lines into an existing project: each line is auto-matched to a
 * local item by MPN, then alias (§4), and added — matched lines link to the item
 * (inheriting its cost snapshot), unmatched lines stay as manual rows. Returns how
 * many were added and how many auto-matched. The shared engine behind
 * {@link useImportBom} (import into an existing project) and
 * {@link useCreateProjectFromBom} (import as a brand-new project), so both entry
 * points auto-match identically.
 */
async function importBomLinesInto(
  projectId: string,
  lines: readonly ParsedBomLine[],
): Promise<BomImportSummary> {
  const items = getItemRepository();
  const projects = getProjectRepository();
  let added = 0;
  let matched = 0;
  for (const line of lines) {
    const match = line.mpn ? await items.findByMatchKey(line.mpn) : undefined;
    if (match) matched += 1;
    await projects.addLine(projectId, {
      itemId: match?.id ?? null,
      designator: line.designator,
      mpn: line.mpn,
      manufacturer: line.manufacturer,
      description: line.description,
      requiredQty: line.requiredQty,
    });
    added += 1;
  }
  return { added, matched };
}

/**
 * Import parsed BOM lines into a project: each line is auto-matched to a local item
 * by MPN, then alias (§4), and added — matched lines link to the item (inheriting
 * its cost snapshot), unmatched lines stay as manual rows. Returns how many were
 * added and how many auto-matched.
 */
export function useImportBom(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (lines: readonly ParsedBomLine[]): Promise<BomImportSummary> =>
      importBomLinesInto(projectId, lines),
    onSettled: () => invalidateProject(client, projectId),
  });
}

/** The new project's id alongside the {@link BomImportSummary} for its imported lines. */
export interface CreateProjectFromBomResult extends BomImportSummary {
  readonly projectId: string;
}

/**
 * Create a brand-new project from an imported order / BOM (spec §4): the project is
 * created first, then the parsed lines are imported into it through the same
 * MPN/alias auto-match path as {@link useImportBom}. Returns the new project's id so
 * the caller can select it, plus the line-import summary. Turns a loose CSV/KiCad
 * order into a standalone planning project in one step, reusing the existing project
 * and BOM write paths (no new SQL).
 */
export function useCreateProjectFromBom() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      project,
      lines,
    }: {
      project: CreateProjectInput;
      lines: readonly ParsedBomLine[];
    }): Promise<CreateProjectFromBomResult> => {
      const created = await getProjectRepository().create(project);
      const summary = await importBomLinesInto(created.id, lines);
      return { projectId: created.id, ...summary };
    },
    onSettled: (data) => {
      void client.invalidateQueries({ queryKey: projectKeys.list() });
      return data ? invalidateProject(client, data.projectId) : undefined;
    },
  });
}

// --- assembly ------------------------------------------------------------------

export function useFinaliseAssembly(projectId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'projects.writeError.heading.finaliseAssembly',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: FinaliseAssemblyInput) => getProjectRepository().finaliseAssembly(projectId, input),
    // Surface a rejected assembly finalisation rather than letting it fail silently (#389).
    onError: reportFailure,
    onSettled: () => {
      // Assembly creates/moves/consumes items and may create a location.
      invalidateItems(client);
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
      return invalidateProject(client, projectId);
    },
  });
}
