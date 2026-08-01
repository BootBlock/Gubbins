/**
 * The shared count sheet for one location (spec §4.4): the blind DISCRETE count inputs
 * (each with a live variance chip) and the SERIALISED presence toggles. Extracted from
 * {@link CycleCountDialog} so the standalone dialog and the guided audit-day stepper
 * render the identical sheet — the only thing that differs between the two is the footer
 * (Close/Authorise vs Skip/Authorise-&-continue), which each caller owns.
 *
 * Purely presentational: all state (counts, presence) is threaded in from
 * {@link useLocationCycleCount}; this component holds none of its own.
 */
import { Button, Input, Tooltip } from '@/components/foundry';
import { serialisedLabel } from '../cycle-count';
import type { LocationCycleCount } from '../useLocationCycleCount';

export function CycleCountLines({ count }: { count: LocationCycleCount }) {
  const { lines, counts, setCount, serialised, presence, setPresence } = count;
  return (
    <>
      {lines.length > 0 && (
        <ul className="space-y-1.5" data-testid="cycle-count-lines">
          {lines.map((line) => {
            const raw = counts[line.key] ?? '';
            const counted = raw.trim().length ? Number(raw) : null;
            const variance = counted !== null ? counted - line.expected : null;
            return (
              <li key={line.key} className="flex items-center gap-3 rounded-lg bg-secondary/30 px-3 py-2">
                <span className="flex-1 text-sm font-medium">{line.name}</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={raw}
                  onChange={(e) => setCount(line.key, e.target.value)}
                  placeholder="count"
                  className="w-24"
                  aria-label={`Counted quantity for ${line.name}`}
                  data-testid={`count-${line.key}`}
                />
                <span
                  className={
                    variance === null
                      ? 'w-16 text-right text-xs text-muted-foreground'
                      : variance === 0
                        ? 'w-16 text-right text-xs text-success'
                        : 'w-16 text-right text-xs font-semibold text-warning'
                  }
                >
                  {variance === null ? '—' : variance === 0 ? 'OK' : `${variance > 0 ? '+' : ''}${variance}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {serialised.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Serialised instances
          </p>
          <ul className="space-y-1.5" data-testid="serialised-audit-lines">
            {serialised.map((line) => {
              const state = presence[line.itemId] ?? 'PRESENT';
              const isMissing = state === 'MISSING';
              return (
                <li
                  key={line.itemId}
                  className="flex items-center gap-3 rounded-lg bg-secondary/30 px-3 py-2"
                >
                  <span className="flex-1 text-sm font-medium">{serialisedLabel(line)}</span>
                  <Tooltip
                    content="Toggle this instance between **present** and **missing**. A missing instance is reconciled on authorisation by a *reversible* soft-delete — it leaves active inventory but can be restored."
                    triggerTabIndex={-1}
                  >
                    <span>
                      <Button
                        type="button"
                        variant={isMissing ? 'destructive' : 'ghost'}
                        className="h-7 px-3 text-xs"
                        onClick={() => setPresence(line.itemId, isMissing ? 'PRESENT' : 'MISSING')}
                        data-testid={`presence-${line.itemId}`}
                      >
                        {isMissing ? 'Missing' : 'Present'}
                      </Button>
                    </span>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
