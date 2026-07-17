import { Banner, Button, Checkbox, Spinner } from '@/components/foundry';
import { AssemblyIcon, PackageIcon, PinIcon } from '@/components/icons';
import { usePickList, useSetPicked } from '../projects';
import { describePlacements, summarisePicking } from '../picking';
import type { PickLine } from '@/db/repositories';

/** The display name for a BOM line — the same precedence the BOM table uses. */
function lineLabel(line: PickLine['line']): string {
  return line.description ?? line.mpn ?? line.designator ?? 'Unnamed part';
}

/**
 * The picking worksheet (issue #121): turns the project's BOM into a location-aware
 * walk-and-tick-off task. Each line shows where its matched stock physically sits (drawn
 * from `item_stock`) and a checkbox to mark it gathered; once every line is ticked, the
 * section surfaces the natural "all picked → finalise" step. Progress and the location
 * phrasing come from the pure `picking` seam; the whole thing is a gathering pass ahead of
 * the existing one-shot assembly.
 */
export function PickingSection({
  projectId,
  onFinalise,
}: {
  projectId: string;
  /** Open the finalise-assembly flow — surfaced once every line is gathered. */
  onFinalise: () => void;
}) {
  const pickList = usePickList(projectId);
  const setPicked = useSetPicked(projectId);

  const rows = pickList.data ?? [];
  const progress = summarisePicking(rows.map((r) => r.line));
  const percent = Math.round(progress.fraction * 100);

  return (
    <section aria-label="Picking">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4">
        <PackageIcon />
        Picking
        <span className="text-xs font-normal text-muted-foreground">(gather each part, tick it off)</span>
      </h3>

      {pickList.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No parts to pick yet. Add a line or import a BOM to start a picking list.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Gathering progress. */}
          <div className="flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-secondary"
              role="progressbar"
              aria-valuenow={progress.pickedCount}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-label="Picking progress"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-emphasized"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="pick-progress">
              {progress.pickedCount} of {progress.total} gathered
            </span>
          </div>

          {progress.allPicked ? (
            <Banner tone="success" className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">All parts gathered — ready to finalise.</span>
              <Button variant="primary" size="sm" className="ml-auto" onClick={onFinalise}>
                <AssemblyIcon />
                Finalise
              </Button>
            </Banner>
          ) : null}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary/50 text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2 font-medium">
                    <span className="sr-only">Picked</span>
                  </th>
                  <th className="px-3 py-2 font-medium">Part</th>
                  <th className="px-3 py-2 font-medium">Need</th>
                  <th className="px-3 py-2 font-medium">Where to find it</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ line, placements }) => {
                  const label = lineLabel(line);
                  const where = describePlacements(placements);
                  return (
                    <tr key={line.id} className="border-t border-border/60 align-middle">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={line.picked}
                          aria-label={`Mark "${label}" as picked`}
                          data-testid={`pick-${line.id}`}
                          disabled={setPicked.isPending}
                          onChange={(e) => setPicked.mutate({ lineId: line.id, picked: e.target.checked })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div
                          className={
                            line.picked ? 'font-medium text-muted-foreground line-through' : 'font-medium'
                          }
                        >
                          {label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {[line.designator, line.mpn, line.manufacturer].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{line.requiredQty}</td>
                      <td className="px-3 py-2 text-xs">
                        {where ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
                            <PinIcon aria-hidden />
                            <span className="text-foreground">{where}</span>
                          </span>
                        ) : line.itemId ? (
                          <span className="text-warning">Not in stock</span>
                        ) : (
                          <span className="text-muted-foreground">— no matched item</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
