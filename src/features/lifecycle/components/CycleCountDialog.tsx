/**
 * Cycle Counting & Reconciliation workflow (spec §4.4). The user blind-counts the
 * DISCRETE items in a location; the dialog highlights variances against the expected
 * database quantities and, on authorisation, persists a Reconciliation Adjustment
 * per drifted line (item quantity + a `RECONCILED` ledger entry). The transient
 * count lives in the Tier-3 {@link CycleCountProvider}; the variance arithmetic and
 * ledger notes come from the pure, unit-tested `cycle-count` module.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, Modal } from '@/components/foundry';
import { getItemRepository, type ReconciliationAdjustment } from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { variances, reconciliationNote, type CycleCountLine } from '../cycle-count';
import { CycleCountProvider, useCycleCount } from '../CycleCountContext';
import { useReconcile } from '../hooks';

export function CycleCountDialog({
  open,
  onClose,
  location,
}: {
  open: boolean;
  onClose: () => void;
  location: { id: string; name: string };
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Cycle count — ${location.name}`}
      description="Blind-count the items in this location, then authorise any variances."
      className="max-w-xl"
    >
      <CycleCountProvider>
        <CycleCountBody location={location} onClose={onClose} />
      </CycleCountProvider>
    </Modal>
  );
}

function CycleCountBody({
  location,
  onClose,
}: {
  location: { id: string; name: string };
  onClose: () => void;
}) {
  const { lines, counts, begin, setCount } = useCycleCount();
  const reconcile = useReconcile();
  const [applied, setApplied] = useState<number | null>(null);

  // Load the DISCRETE items currently in the location as the blind-count lines.
  const { data, isLoading } = useQuery({
    queryKey: [...inventoryKeys.itemList({ locationId: location.id }), 'cycle-count'],
    queryFn: () => getItemRepository().list({ locationId: location.id, limit: 100 }),
  });

  useEffect(() => {
    if (!data) return;
    const discrete = data.rows.filter((i) => i.trackingMode === 'DISCRETE');
    begin(location, discrete.map((i) => ({ itemId: i.id, name: i.name, expected: i.quantity })));
  }, [data, begin, location]);

  // Only lines the user actually entered a number for participate (blind count).
  const countedLines: CycleCountLine[] = lines
    .filter((l) => counts[l.itemId]?.trim().length)
    .map((l) => ({ itemId: l.itemId, name: l.name, expected: l.expected, counted: Number(counts[l.itemId]) }));
  const drift = variances(countedLines);

  const authorise = () => {
    const adjustments: ReconciliationAdjustment[] = drift.map((d) => ({
      itemId: d.itemId,
      counted: d.counted,
      note: reconciliationNote(d, location.name),
    }));
    reconcile.mutate(adjustments, {
      onSuccess: (updated) => setApplied(updated.length),
    });
  };

  if (applied !== null) {
    return (
      <div className="space-y-4 py-2 text-center">
        <p className="text-sm" data-testid="cycle-count-result">
          Reconciliation complete — {applied} adjustment{applied === 1 ? '' : 's'} applied to the ledger.
        </p>
        <Button onClick={onClose}>Done</Button>
      </div>
    );
  }

  if (isLoading) return <p className="py-6 text-center text-sm text-muted-foreground">Loading items…</p>;
  if (lines.length === 0) {
    return (
      <div className="space-y-4 py-2">
        <p className="text-sm text-muted-foreground">No bulk-tracked items in this location to count.</p>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
      <ul className="space-y-1.5" data-testid="cycle-count-lines">
        {lines.map((line) => {
          const raw = counts[line.itemId] ?? '';
          const counted = raw.trim().length ? Number(raw) : null;
          const variance = counted !== null ? counted - line.expected : null;
          return (
            <li key={line.itemId} className="flex items-center gap-3 rounded-lg bg-secondary/30 px-3 py-2">
              <span className="flex-1 text-sm font-medium">{line.name}</span>
              <Input
                type="number"
                min={0}
                step={1}
                value={raw}
                onChange={(e) => setCount(line.itemId, e.target.value)}
                placeholder="count"
                className="w-24"
                data-testid={`count-${line.itemId}`}
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

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-muted-foreground">
          {drift.length} variance{drift.length === 1 ? '' : 's'} of {countedLines.length} counted
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={authorise}
            disabled={reconcile.isPending || drift.length === 0}
            data-testid="authorise-reconciliation"
          >
            Authorise {drift.length > 0 ? `(${drift.length})` : ''}
          </Button>
        </div>
      </div>
    </div>
  );
}
