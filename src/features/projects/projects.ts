/**
 * Tier-1 hooks for the projects domain (spec §2.1, §4 Projects & BOMs).
 *
 * Reads go through TanStack Query; writes use targeted invalidation (project edits
 * are low-frequency and reshape derived counts/costing/shopping-list aggregates, so
 * invalidation is simpler and safer than optimistic patching here — the same
 * deliberate split the category/tag hooks use). A project's BOM, costing and
 * shopping list are bounded per-project sets, fetched whole rather than virtualised;
 * the strict-pagination mandate (§2.1) targets the 100k+ item list.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getItemRepository,
  getProjectRepository,
  type CostingMode,
  type CreateBomLineInput,
  type CreateProjectInput,
  type FinaliseAssemblyInput,
  type ProcurementStatus,
  type ReservationStatus,
  type UpdateBomLineInput,
  type UpdateProjectInput,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import type { ParsedBomLine } from './bom-import';

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, 'detail', id] as const,
  lines: (id: string) => [...projectKeys.detail(id), 'lines'] as const,
  costing: (id: string) => [...projectKeys.detail(id), 'costing'] as const,
  shoppingList: (id: string) => [...projectKeys.detail(id), 'shopping-list'] as const,
} as const;

// --- reads ---------------------------------------------------------------------

export function useProjects() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => getProjectRepository().list({ limit: 100 }),
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectKeys.detail(id ?? ''),
    queryFn: () => getProjectRepository().getById(id!),
    enabled: Boolean(id),
  });
}

export function useBomLines(projectId: string | undefined) {
  return useQuery({
    queryKey: projectKeys.lines(projectId ?? ''),
    queryFn: () => getProjectRepository().listLines(projectId!, { limit: 100 }),
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

// --- write helpers -------------------------------------------------------------

/** Invalidate every derived view of a single project (lines, costing, shopping). */
function invalidateProject(
  client: ReturnType<typeof useQueryClient>,
  projectId: string,
): void {
  void client.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
  void client.invalidateQueries({ queryKey: projectKeys.list() });
}

// --- projects ------------------------------------------------------------------

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => getProjectRepository().create(input),
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
  return useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: CostingMode }) =>
      getProjectRepository().setCostingMode(id, mode),
    onSettled: (_data, _err, vars) => invalidateProject(client, vars.id),
  });
}

export function useDeleteProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getProjectRepository().delete(id),
    onSettled: () => void client.invalidateQueries({ queryKey: projectKeys.list() }),
  });
}

// --- BOM lines -----------------------------------------------------------------

export function useAddBomLine(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBomLineInput) => getProjectRepository().addLine(projectId, input),
    onSettled: () => invalidateProject(client, projectId),
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
  return useMutation({
    mutationFn: (lineId: string) => getProjectRepository().removeLine(lineId),
    onSettled: () => invalidateProject(client, projectId),
  });
}

// --- reservations & procurement ------------------------------------------------

export function useSetReservation(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      lineId,
      status,
      qty,
    }: {
      lineId: string;
      status: ReservationStatus;
      qty?: number;
    }) => getProjectRepository().setReservation(lineId, status, qty),
    onSettled: (_data, _err, vars) => {
      invalidateProject(client, projectId);
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(vars.lineId) });
    },
  });
}

export function useSetProcurement(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, status }: { lineId: string; status: ProcurementStatus }) =>
      getProjectRepository().setProcurement(lineId, status),
    onSettled: () => {
      invalidateProject(client, projectId);
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

export function useReceiveLine(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      lineId,
      locationId,
      quantity,
    }: {
      lineId: string;
      locationId?: string;
      quantity?: number;
    }) => getProjectRepository().receiveLine(lineId, { locationId, quantity }),
    onSettled: () => {
      invalidateProject(client, projectId);
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

// --- BOM import (spec §4 CSV/KiCad ingress with MPN/alias auto-match) -----------

export interface BomImportSummary {
  readonly added: number;
  readonly matched: number;
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
    mutationFn: async (lines: readonly ParsedBomLine[]): Promise<BomImportSummary> => {
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
    },
    onSettled: () => invalidateProject(client, projectId),
  });
}

// --- assembly ------------------------------------------------------------------

export function useFinaliseAssembly(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: FinaliseAssemblyInput) =>
      getProjectRepository().finaliseAssembly(projectId, input),
    onSettled: () => {
      invalidateProject(client, projectId);
      // Assembly creates/moves/consumes items and may create a location.
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}
