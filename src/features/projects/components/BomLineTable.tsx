import { useState } from 'react';
import { Button, Input, Select, Tooltip } from '@/components/foundry';
import { DeleteIcon, TruckIcon } from '@/components/icons';
import {
  PROCUREMENT_STATUSES,
  RESERVATION_STATUSES,
  type ProcurementStatus,
  type ProjectBomLine,
  type ReservationStatus,
} from '@/db/repositories';
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
  onReceive,
}: {
  line: ProjectBomLine;
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
          onClick={() => onReceive(clamped, batch)}
        >
          <TruckIcon className="text-glyph-success" />
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
 */
export function BomLineTable({ projectId, lines }: { projectId: string; lines: readonly ProjectBomLine[] }) {
  const setReservation = useSetReservation(projectId);
  const setProcurement = useSetProcurement(projectId);
  const receiveLine = useReceiveLine(projectId);
  const removeLine = useRemoveBomLine(projectId);

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
          {lines.map((line) => (
            <tr key={line.id} className="border-t border-border/60 align-middle">
              <td className="px-3 py-2">
                <div className="font-medium">
                  {line.description ?? line.mpn ?? line.designator ?? 'Unnamed part'}
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
                      onClick={() => removeLine.mutate(line.id)}
                    >
                      <DeleteIcon className="text-glyph-danger" />
                    </Button>
                  </span>
                </Tooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
