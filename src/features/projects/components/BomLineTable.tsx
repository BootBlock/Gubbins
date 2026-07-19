import { useMemo, useState } from 'react';
import { Button, Input, Select, Spinner, Tooltip } from '@/components/foundry';
import { DeleteIcon, TruckIcon, WarningIcon } from '@/components/icons';
import {
  PROCUREMENT_STATUSES,
  RESERVATION_STATUSES,
  type ProcurementStatus,
  type ProjectBomLine,
  type ReservationStatus,
} from '@/db/repositories';
import { useItemsRelations } from '@/features/inventory/queries';
import { missingRequirementsByLine } from '@/features/inventory/item-requirements';
import { useRemoveBomLine, useSetProcurement, useSetReservation, useReceiveLine } from '../projects';
import { outstandingQty } from '../receipts';
import { PROCUREMENT_STATUS_LABELS, RESERVATION_STATUS_LABELS } from './projects-ui';

/** An optional batch/lot identity entered on a receipt (Phase 28). */
export interface ReceiveBatch {
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly expiryDate: number | null;
}

/**
 * The In-Transit receive control (spec §4 partial / split receipts; batch-aware Phase 28):
 * a quantity field defaulting to the outstanding remainder beside the "receive" action, so a
 * line can be received whole or in instalments. Keyed by the line's received total upstream,
 * so each accepted instalment re-seeds the field with the new remainder. An optional batch
 * number + expiry tags the arriving units with their lot, so they enter their own
 * `stock_batches` row (FEFO-tracked); left blank, the units fall into the untracked remainder.
 */
function ReceiveControl({
  line,
  pending,
  busy,
  onReceive,
}: {
  line: ProjectBomLine;
  /** A receipt is in flight anywhere in the table — every receive control locks (issue #303). */
  pending: boolean;
  /** …and *this* is the line being received, so only this control shows the wait. */
  busy: boolean;
  onReceive: (qty: number, batch?: ReceiveBatch) => void;
}) {
  const outstanding = outstandingQty(line);
  const [qty, setQty] = useState(outstanding);
  const [batchNumber, setBatchNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const clamped = Math.min(Math.max(1, qty || 1), outstanding);

  const batch: ReceiveBatch | undefined =
    batchNumber.trim() || expiry
      ? {
          batchNumber: batchNumber.trim() || null,
          lotNumber: null,
          expiryDate: expiry ? new Date(expiry).getTime() : null,
        }
      : undefined;

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        // Coerced-on-keystroke controlled field — opt out of the calculator (issue #93).
        calc={false}
        min={1}
        max={outstanding}
        value={qty}
        aria-label="Quantity to receive"
        className="h-8 w-16 text-xs"
        onChange={(e) => setQty(Math.floor(Number(e.target.value)))}
      />
      <Input
        type="text"
        value={batchNumber}
        aria-label="Batch number (optional)"
        placeholder="batch"
        data-testid={`receive-batch-${line.id}`}
        className="h-8 w-20 text-xs"
        onChange={(e) => setBatchNumber(e.target.value)}
      />
      <Input
        type="date"
        value={expiry}
        aria-label="Expiry date (optional)"
        data-testid={`receive-expiry-${line.id}`}
        className="h-8 w-32 text-xs"
        onChange={(e) => setExpiry(e.target.value)}
      />
      <Tooltip content={`Receive ${clamped} into stock${batch ? ' (batch tracked)' : ''}`}>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          aria-label="Receive into stock"
          disabled={pending}
          onClick={() => onReceive(clamped, batch)}
        >
          {busy ? (
            // Decorative: the button's own `aria-label` already names the action, so a second
            // `role="status"` live region would just announce an unattributed "Loading".
            <Spinner decorative className="size-4" />
          ) : (
            <TruckIcon className="text-glyph-success" />
          )}
        </Button>
      </Tooltip>
    </div>
  );
}

/**
 * The BOM table (spec §4): each required part with its reservation (Tentative vs
 * Actual) and procurement (Ordered → In-Transit → Received) controls inline. The
 * "In Transit" state is the liminal procurement space of §4; an In-Transit line can
 * be received into stock whole or in partial instalments (Phase 24).
 *
 * Every action locks while its mutation is in flight (issue #303). Receiving is the
 * consequential one — a second click before the first receipt settles would book the
 * arriving quantity into stock twice — but the guard is applied uniformly rather than
 * left to per-action reasoning about which writes happen to be idempotent. A mutation's
 * `isPending` is shared by the whole table, so it *locks* every row but the wait is only
 * *shown* on the row it was fired from (matched on the mutation's `variables`).
 */
export function BomLineTable({ projectId, lines }: { projectId: string; lines: readonly ProjectBomLine[] }) {
  const setReservation = useSetReservation(projectId);
  const setProcurement = useSetProcurement(projectId);
  const receiveLine = useReceiveLine(projectId);
  const removeLine = useRemoveBomLine(projectId);

  // Hard dependencies (issue #70): a line whose item `REQUIRES` something no *other* line covers
  // is flagged, so a BOM that would build into an unusable assembly says so before it is picked.
  // One batched read for every matched line; the pure seam does the set arithmetic.
  const lineItemIds = useMemo(
    () => lines.map((l) => l.itemId).filter((id): id is string => id !== null),
    [lines],
  );
  const { data: relationsByItem } = useItemsRelations(lineItemIds);
  const missingByItem = useMemo(
    () => missingRequirementsByLine(lineItemIds, relationsByItem ?? new Map()),
    [lineItemIds, relationsByItem],
  );
  // Relation id → the required item's display name, for naming the gap in the flag's tooltip.
  const requiredNameByRelationId = useMemo(() => {
    const out = new Map<string, string>();
    for (const views of relationsByItem?.values() ?? []) {
      for (const view of views) {
        out.set(view.id, view.otherItemName);
      }
    }
    return out;
  }, [relationsByItem]);

  if (lines.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No parts yet. Add a line or import a BOM to get started.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-secondary/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Part</th>
            <th className="px-3 py-2 font-medium">Qty</th>
            <th className="px-3 py-2 font-medium">Reservation</th>
            <th className="px-3 py-2 font-medium">Procurement</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const missing = line.itemId ? (missingByItem.get(line.itemId) ?? []) : [];
            const missingNames = missing
              .map((m) => requiredNameByRelationId.get(m.relationId))
              .filter((n): n is string => n !== undefined);
            return (
              <tr key={line.id} className="border-t border-border/60 align-middle">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5 font-medium">
                    <span>{line.description ?? line.mpn ?? line.designator ?? 'Unnamed part'}</span>
                    {missingNames.length > 0 ? (
                      <Tooltip
                        content={`This part requires ${missingNames.join(', ')}, which ${
                          missingNames.length === 1 ? 'is' : 'are'
                        } not on this bill of materials. Add ${
                          missingNames.length === 1 ? 'it' : 'them'
                        } so the assembly is complete.`}
                        triggerTabIndex={-1}
                      >
                        <span
                          className="inline-flex text-warning [&_svg]:size-4"
                          data-testid={`bom-missing-requirement-${line.id}`}
                        >
                          {/* Meaningful, not decorative — `role="img"` + a label so the gap is
                              announced rather than being a colour-only signal (WCAG 1.4.1). */}
                          <WarningIcon
                            role="img"
                            aria-label={`Missing prerequisite — requires ${missingNames.join(', ')}`}
                          />
                        </span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[line.designator, line.mpn, line.manufacturer].filter(Boolean).join(' · ') || '—'}
                    {line.itemId ? null : <span className="ml-1 text-warning">· unmatched</span>}
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {line.reservedQty > 0 ? `${line.reservedQty}/${line.requiredQty}` : line.requiredQty}
                  {line.receivedQty > 0 ? (
                    <div className="text-xs text-success" data-testid={`received-progress-${line.id}`}>
                      {line.receivedQty}/{line.requiredQty} received
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <Select
                    className="h-8 text-xs"
                    value={line.reservationStatus}
                    aria-label="Reservation status"
                    disabled={setReservation.isPending}
                    onChange={(value) =>
                      setReservation.mutate({ lineId: line.id, status: value as ReservationStatus })
                    }
                    options={RESERVATION_STATUSES.map((s) => ({
                      value: s,
                      label: RESERVATION_STATUS_LABELS[s],
                    }))}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <Select
                      className="h-8 text-xs"
                      value={line.procurementStatus}
                      aria-label="Procurement status"
                      disabled={setProcurement.isPending}
                      onChange={(value) =>
                        setProcurement.mutate({ lineId: line.id, status: value as ProcurementStatus })
                      }
                      options={PROCUREMENT_STATUSES.map((s) => ({
                        value: s,
                        label: PROCUREMENT_STATUS_LABELS[s],
                      }))}
                    />
                    {line.itemId && line.procurementStatus === 'IN_TRANSIT' ? (
                      <ReceiveControl
                        key={line.receivedQty}
                        line={line}
                        pending={receiveLine.isPending}
                        busy={receiveLine.isPending && receiveLine.variables?.lineId === line.id}
                        onReceive={(quantity, batch) =>
                          receiveLine.mutate({ lineId: line.id, quantity, batch })
                        }
                      />
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <Tooltip
                    content="Remove this part from the bill of materials. Any matched inventory stock is unaffected."
                    triggerTabIndex={-1}
                  >
                    <span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label="Remove line"
                        disabled={removeLine.isPending}
                        onClick={() => removeLine.mutate(line.id)}
                      >
                        {removeLine.isPending && removeLine.variables === line.id ? (
                          <Spinner decorative className="size-4" />
                        ) : (
                          <DeleteIcon className="text-glyph-danger" />
                        )}
                      </Button>
                    </span>
                  </Tooltip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
