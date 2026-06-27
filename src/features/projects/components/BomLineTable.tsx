import { Button, Select, Tooltip } from '@/components/foundry';
import { DeleteIcon, TruckIcon } from '@/components/icons';
import {
  PROCUREMENT_STATUSES,
  RESERVATION_STATUSES,
  type ProcurementStatus,
  type ProjectBomLine,
  type ReservationStatus,
} from '@/db/repositories';
import { useRemoveBomLine, useSetProcurement, useSetReservation, useReceiveLine } from '../projects';
import { PROCUREMENT_STATUS_LABELS, RESERVATION_STATUS_LABELS } from './projects-ui';

/**
 * The BOM table (spec §4): each required part with its reservation (Tentative vs
 * Actual) and procurement (Ordered → In-Transit → Received) controls inline. The
 * "In Transit" state is the liminal procurement space of §4.
 */
export function BomLineTable({
  projectId,
  lines,
}: {
  projectId: string;
  lines: readonly ProjectBomLine[];
}) {
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
                <div className="font-medium">{line.description ?? line.mpn ?? line.designator ?? 'Unnamed part'}</div>
                <div className="text-xs text-muted-foreground">
                  {[line.designator, line.mpn, line.manufacturer].filter(Boolean).join(' · ') || '—'}
                  {line.itemId ? null : <span className="ml-1 text-warning">· unmatched</span>}
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums">
                {line.reservedQty > 0 ? `${line.reservedQty}/${line.requiredQty}` : line.requiredQty}
              </td>
              <td className="px-3 py-2">
                <Select
                  className="h-8 text-xs"
                  value={line.reservationStatus}
                  aria-label="Reservation status"
                  onChange={(e) =>
                    setReservation.mutate({
                      lineId: line.id,
                      status: e.target.value as ReservationStatus,
                    })
                  }
                >
                  {RESERVATION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {RESERVATION_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <Select
                    className="h-8 text-xs"
                    value={line.procurementStatus}
                    aria-label="Procurement status"
                    onChange={(e) =>
                      setProcurement.mutate({
                        lineId: line.id,
                        status: e.target.value as ProcurementStatus,
                      })
                    }
                  >
                    {PROCUREMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {PROCUREMENT_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                  {line.itemId && line.procurementStatus === 'IN_TRANSIT' ? (
                    <Tooltip content="Receive into stock">
                      <Button
                        size="icon"
                        variant="outline"
                        className="size-8"
                        aria-label="Receive into stock"
                        onClick={() => receiveLine.mutate({ lineId: line.id })}
                      >
                        <TruckIcon />
                      </Button>
                    </Tooltip>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  aria-label="Remove line"
                  onClick={() => removeLine.mutate(line.id)}
                >
                  <DeleteIcon />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
