/**
 * Cycle Counting & Reconciliation workflow (spec §4.4). The user blind-counts the
 * DISCRETE items in a location; the dialog highlights variances against the expected
 * database quantities and, on authorisation, persists a Reconciliation Adjustment
 * per drifted line (item quantity + a `RECONCILED` ledger entry). The same dialog
 * audits SERIALISED instances by **presence** — each qty-1 unit is flagged present
 * or missing, and a missing instance is reconciled by a reversible soft-delete. The
 * transient count lives in the Tier-3 {@link CycleCountProvider}; the variance
 * arithmetic and ledger notes come from the pure, unit-tested `cycle-count` module.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Input, LiveRegion, Modal, Tooltip } from '@/components/foundry';
import {
  getItemRepository,
  type ReconciliationAdjustment,
  type SerialisedReconciliation,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import {
  variances,
  reconciliationNote,
  missingInstances,
  serialisedAuditNote,
  serialisedLabel,
  type CycleCountLine,
} from '../cycle-count';
import { CycleCountProvider, useCycleCount } from '../CycleCountContext';
import { useReconcile, useReconcileSerialised } from '../hooks';

/** A count line's label: the item name, with the lot's batch/lot number appended if tracked. */
function batchLineLabel(name: string, batchNumber: string | null, lotNumber: string | null): string {
  const tag = batchNumber ?? lotNumber;
  return tag ? `${name} · ${batchNumber ? 'Batch' : 'Lot'} ${tag}` : name;
}

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
  const { lines, counts, serialised, presence, begin, setCount, setPresence } = useCycleCount();
  const reconcile = useReconcile();
  const reconcileSerialised = useReconcileSerialised();
  const [applied, setApplied] = useState<number | null>(null);

  // Load the items physically in this location (Phase 26 — per-location; Phase 28 — per-batch).
  // DISCRETE stock is read from the `stock_batches` ledger, so a drawer's lots are each
  // counted separately (the expected count is *this lot's* on-hand here) and an item primarily
  // housed elsewhere with a placement here is included; SERIALISED instances (single-placement,
  // qty 1) feed the presence audit from the item list.
  const { data, isLoading } = useQuery({
    queryKey: [...inventoryKeys.itemList({ locationId: location.id }), 'cycle-count'],
    queryFn: async () => {
      const repo = getItemRepository();
      const [discrete, byPrimary] = await Promise.all([
        repo.listStockBatchesAtLocation(location.id),
        repo.list({ locationId: location.id, limit: 100 }),
      ]);
      return {
        discrete,
        serialised: byPrimary.rows.filter((i) => i.trackingMode === 'SERIALISED'),
      };
    },
  });

  useEffect(() => {
    if (!data) return;
    begin(
      location,
      data.discrete.map((b) => ({
        key: `${b.itemId}|${b.batchKey}`,
        itemId: b.itemId,
        name: batchLineLabel(b.name, b.batchNumber, b.lotNumber),
        expected: b.quantity,
        batch: { batchNumber: b.batchNumber, lotNumber: b.lotNumber, expiryDate: b.expiryDate },
      })),
      data.serialised.map((i) => ({ itemId: i.id, name: i.name, serialNo: i.serialNo })),
    );
  }, [data, begin, location]);

  // Only lines the user actually entered a number for participate (blind count).
  const countedLines: CycleCountLine[] = lines
    .filter((l) => counts[l.key]?.trim().length)
    .map((l) => ({ itemId: l.itemId, name: l.name, expected: l.expected, counted: Number(counts[l.key]) }));
  const drift = variances(countedLines);
  const missing = missingInstances(serialised, presence);
  const pending = reconcile.isPending || reconcileSerialised.isPending;
  const totalToApply = drift.length + missing.length;

  // The completion message — null until reconciliation succeeds. Kept as a derived string so a
  // single always-mounted LiveRegion (below) receives it as mutating children (WCAG 4.1.3).
  // Using a string rather than JSX lets the region stay stable across view transitions: the
  // same DOM node watches for changes in the form view and then receives content once applied
  // is set, guaranteeing assistive tech will announce the update.
  const resultMessage =
    applied !== null
      ? `Reconciliation complete — ${applied} adjustment${applied === 1 ? '' : 's'} applied to the ledger.`
      : null;

  const authorise = async () => {
    // Build one adjustment per *drifted batch line* (Phase 28): the variance is absorbed at
    // that lot's `stock_batches` row at this placement, so a drawer's lots reconcile
    // independently. Built from the session lines (which carry the lot identity), keeping the
    // note arithmetic in the pure `reconciliationNote`.
    const quantityAdjustments: ReconciliationAdjustment[] = lines
      .filter((l) => counts[l.key]?.trim().length && Number(counts[l.key]) !== l.expected)
      .map((l) => {
        const counted = Number(counts[l.key]);
        return {
          itemId: l.itemId,
          counted,
          note: reconciliationNote(
            { itemId: l.itemId, name: l.name, expected: l.expected, counted, variance: counted - l.expected },
            location.name,
          ),
          locationId: location.id,
          batch: l.batch,
        };
      });
    const serialisedAdjustments: SerialisedReconciliation[] = missing.map((m) => ({
      itemId: m.itemId,
      note: serialisedAuditNote(m, location.name),
    }));
    const updatedDiscrete = quantityAdjustments.length
      ? await reconcile.mutateAsync(quantityAdjustments)
      : [];
    const updatedSerialised = serialisedAdjustments.length
      ? await reconcileSerialised.mutateAsync(serialisedAdjustments)
      : [];
    setApplied(updatedDiscrete.length + updatedSerialised.length);
  };

  // Single return with one stable LiveRegion across ALL view states (form / result / loading).
  // This satisfies the WCAG 4.1.3 / screen-reader contract: the region is always mounted, so
  // when `resultMessage` changes from null → string the SR announces the mutation. If the
  // LiveRegion only appeared inside the result view it would mount together with its content
  // and many SRs would not announce it.
  return (
    <>
      {/*
        Always-mounted polite live region — present in the form view (empty) and in the result
        view (populated). The result message IS the visible feedback, so visuallyHidden is
        omitted; the region renders in place as a styled paragraph. Class and testid are stable
        across transitions so tests can assert the region before and after reconciliation.
      */}
      <LiveRegion className="text-sm text-center" data-testid="cycle-count-result">
        {resultMessage ? <p>{resultMessage}</p> : null}
      </LiveRegion>

      {applied !== null ? (
        // Result view — shown after a successful reconciliation.
        <div className="space-y-4 py-2 text-center">
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading items…</p>
      ) : lines.length === 0 && serialised.length === 0 ? (
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">No countable items in this location to audit.</p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-h-[70vh] space-y-4 dialog-scroll">
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

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {drift.length + missing.length} adjustment{drift.length + missing.length === 1 ? '' : 's'} to
              authorise
              {missing.length > 0 ? ` (${missing.length} missing)` : ''}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Tooltip
                content="Commit the counted variances: each drifted line writes a Reconciliation Adjustment (new quantity + a `RECONCILED` history entry), and each missing instance is soft-deleted."
                triggerTabIndex={-1}
              >
                <span>
                  <Button
                    onClick={() => void authorise()}
                    disabled={pending || totalToApply === 0}
                    data-testid="authorise-reconciliation"
                  >
                    Authorise {totalToApply > 0 ? `(${totalToApply})` : ''}
                  </Button>
                </span>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
