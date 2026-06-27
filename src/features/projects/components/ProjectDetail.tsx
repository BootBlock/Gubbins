import { useMemo, useState } from 'react';
import { Button, Select, Spinner, Surface, Tooltip } from '@/components/foundry';
import {
  AddIcon,
  AssemblyIcon,
  CostIcon,
  ImportIcon,
  ShoppingCartIcon,
} from '@/components/icons';
import { COSTING_MODES, type CostingMode } from '@/db/repositories';
import { useInventoryItems } from '@/features/inventory/queries';
import { useLocations } from '@/features/inventory/queries';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { formatCurrency } from '@/lib/format';
import {
  useBomLines,
  useProject,
  useProjectCosting,
  useSetCostingMode,
  useShoppingList,
} from '../projects';
import { COSTING_MODE_LABELS, PROJECT_STATUS_LABELS } from './projects-ui';
import { BomLineTable } from './BomLineTable';
import { AddBomLineDialog } from './AddBomLineDialog';
import { ImportBomDialog } from './ImportBomDialog';
import { FinaliseAssemblyDialog } from './FinaliseAssemblyDialog';

/** The selected project's workspace: BOM table, costing toggle and shopping list. */
export function ProjectDetail({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const lines = useBomLines(projectId);
  const costing = useProjectCosting(projectId);
  const shoppingList = useShoppingList(projectId);
  const setCostingMode = useSetCostingMode();
  const { baseCurrency, locale } = usePreferencesStore();

  const itemsQuery = useInventoryItems({}, 100);
  const locationsQuery = useLocations();
  const items = useMemo(
    () => itemsQuery.data?.pages.flatMap((p) => p.rows) ?? [],
    [itemsQuery.data],
  );
  const locations = locationsQuery.data?.rows ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [finaliseOpen, setFinaliseOpen] = useState(false);

  if (project.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!project.data) {
    return <p className="p-8 text-sm text-muted-foreground">Project not found.</p>;
  }

  const money = (value: number) => formatCurrency(value, baseCurrency, locale);
  const lineRows = lines.data?.rows ?? [];
  const list = shoppingList.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-3 pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight">{project.data.name}</h2>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
              {PROJECT_STATUS_LABELS[project.data.status]}
            </span>
          </div>
          {project.data.description ? (
            <p className="truncate text-sm text-muted-foreground">{project.data.description}</p>
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <AddIcon />
            Add line
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <ImportIcon />
            Import BOM
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFinaliseOpen(true)}
            disabled={lineRows.length === 0}
          >
            <AssemblyIcon />
            Finalise
          </Button>
        </div>
      </header>

      {/* Costing summary + mode toggle (§4 BOM Costing) */}
      <Surface className="mb-4 flex flex-wrap items-center gap-4 p-4">
        <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
          <CostIcon />
          <span className="text-sm font-medium text-foreground">Estimated cost</span>
        </div>
        <span className="text-lg font-semibold tabular-nums">
          {costing.data ? money(costing.data.totalCost) : '—'}
        </span>
        {costing.data && costing.data.unpricedLineCount > 0 ? (
          <Tooltip
            content={`${costing.data.unpricedLineCount} line(s) have no unit cost under this mode and are excluded.`}
          >
            <span className="text-xs text-warning">
              {costing.data.unpricedLineCount} unpriced
            </span>
          </Tooltip>
        ) : null}
        <label className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Costing</span>
          <Select
            className="h-8 w-auto text-xs"
            value={project.data.costingMode}
            aria-label="Costing mode"
            onChange={(e) =>
              setCostingMode.mutate({ id: projectId, mode: e.target.value as CostingMode })
            }
          >
            {COSTING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {COSTING_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        </label>
      </Surface>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-4">
        <section>
          <h3 className="mb-2 text-sm font-semibold">Bill of materials</h3>
          {lines.isLoading ? <Spinner /> : <BomLineTable projectId={projectId} lines={lineRows} />}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4">
            <ShoppingCartIcon />
            Shopping list
            <span className="text-xs font-normal text-muted-foreground">
              (required − reserved, not yet ordered)
            </span>
          </h3>
          {list.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Nothing to buy — every part is reserved or on order.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-secondary/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Part</th>
                    <th className="px-3 py-2 font-medium">MPN</th>
                    <th className="px-3 py-2 font-medium">Need</th>
                    <th className="px-3 py-2 font-medium">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((entry, i) => (
                    <tr key={entry.itemId ?? `x${i}`} className="border-t border-border/60">
                      <td className="px-3 py-2">{entry.label}</td>
                      <td className="px-3 py-2 font-mono text-xs">{entry.mpn ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{entry.shortfallQty}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {entry.estimatedCost == null ? '—' : money(entry.estimatedCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <AddBomLineDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        projectId={projectId}
        items={items}
      />
      <ImportBomDialog open={importOpen} onClose={() => setImportOpen(false)} projectId={projectId} />
      <FinaliseAssemblyDialog
        open={finaliseOpen}
        onClose={() => setFinaliseOpen(false)}
        projectId={projectId}
        projectName={project.data.name}
        locations={locations}
      />
    </div>
  );
}
