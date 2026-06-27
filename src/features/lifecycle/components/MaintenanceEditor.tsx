/**
 * Item-detail facet for Tool Maintenance Schedules (spec §4.3). Lists an item's
 * schedules with their *computed* due status (the pure `maintenanceStatus` maths,
 * never stored), and lets the user add a schedule, log a performed service (which
 * resets the schedule and appends a `MAINTENANCE_LOGGED` ledger entry), accrue
 * usage against a usage-based schedule, or remove one.
 */
import { useState } from 'react';
import { Button, Input, Select } from '@/components/foundry';
import { SettingsIcon, AddIcon, DeleteIcon, CheckIcon, WarningIcon } from '@/components/icons';
import { MAINTENANCE_BASES, type MaintenanceBasis, type MaintenanceSchedule } from '@/db/repositories';
import { cn } from '@/lib/utils';
import { MAINTENANCE_BASIS_LABELS } from '@/features/inventory/components/inventory-ui';
import { maintenanceStatus, maintenancePerformedNote } from '../maintenance';
import {
  useAddMaintenanceUsage,
  useCreateMaintenance,
  useItemMaintenance,
  useLogMaintenance,
  useRemoveMaintenance,
} from '../hooks';

export function MaintenanceEditor({ itemId }: { itemId: string }) {
  const { data: schedules } = useItemMaintenance(itemId);
  const create = useCreateMaintenance();
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<MaintenanceBasis>('TIME');
  const [interval, setInterval] = useState('90');
  const [usageUnit, setUsageUnit] = useState('hours');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (name.trim().length === 0) return;
    setError(null);
    const input =
      basis === 'TIME'
        ? { itemId, name: name.trim(), basis, intervalDays: Number(interval) }
        : { itemId, name: name.trim(), basis, intervalUsage: Number(interval), usageUnit: usageUnit.trim() || null };
    create.mutate(input, {
      onSuccess: () => {
        setName('');
        setInterval(basis === 'TIME' ? '90' : '100');
      },
      onError: (e) => setError(e instanceof Error ? e.message : 'Could not add the schedule.'),
    });
  };

  return (
    <div className="space-y-3">
      {schedules && schedules.length > 0 ? (
        <ul className="space-y-2" data-testid="maintenance-list">
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} itemId={itemId} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No maintenance schedules yet.</p>
      )}

      <div className="rounded-xl border border-border p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
          <AddIcon />
          New schedule
        </p>
        <div className="space-y-2">
          <Input
            data-testid="maintenance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lubricate rails"
          />
          <div className="grid grid-cols-3 gap-2">
            <Select value={basis} onChange={(e) => setBasis(e.target.value as MaintenanceBasis)}>
              {MAINTENANCE_BASES.map((b) => (
                <option key={b} value={b}>
                  {MAINTENANCE_BASIS_LABELS[b]}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min={1}
              step={1}
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              aria-label={basis === 'TIME' ? 'Interval in days' : 'Usage interval'}
            />
            {basis === 'USAGE' ? (
              <Input value={usageUnit} onChange={(e) => setUsageUnit(e.target.value)} placeholder="hours" />
            ) : (
              <span className="self-center text-xs text-muted-foreground">days</span>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={add} disabled={create.isPending} data-testid="add-maintenance">
              Add schedule
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({ schedule, itemId }: { schedule: MaintenanceSchedule; itemId: string }) {
  const log = useLogMaintenance();
  const addUsage = useAddMaintenanceUsage();
  const remove = useRemoveMaintenance();
  const [usage, setUsage] = useState('');

  const status = maintenanceStatus(
    {
      basis: schedule.basis,
      intervalDays: schedule.intervalDays,
      intervalUsage: schedule.intervalUsage,
      usageSinceService: schedule.usageSinceService,
      lastPerformedAt: schedule.lastPerformedAt,
      createdAt: schedule.createdAt,
    },
    Date.now(),
  );

  const detail =
    schedule.basis === 'TIME'
      ? `every ${schedule.intervalDays} days${
          status.remainingDays !== null
            ? status.due
              ? ` · ${-status.remainingDays} day(s) overdue`
              : ` · ${status.remainingDays} day(s) left`
            : ''
        }`
      : `every ${schedule.intervalUsage} ${schedule.usageUnit ?? 'units'} · ${schedule.usageSinceService} logged`;

  const performed = () =>
    log.mutate({
      id: schedule.id,
      itemId,
      note: maintenancePerformedNote(
        schedule.name,
        {
          basis: schedule.basis,
          intervalDays: schedule.intervalDays,
          intervalUsage: schedule.intervalUsage,
          usageSinceService: schedule.usageSinceService,
          lastPerformedAt: schedule.lastPerformedAt,
          createdAt: schedule.createdAt,
        },
        Date.now(),
      ),
    });

  return (
    <li
      className={cn(
        'rounded-xl border p-3',
        status.due ? 'border-warning/40 bg-warning/10' : 'border-border',
      )}
      data-testid="maintenance-row"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium [&_svg]:size-3.5">
            {status.due ? <WarningIcon className="text-warning" /> : null}
            {schedule.name}
          </p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={performed} disabled={log.isPending} data-testid="log-maintenance">
            <CheckIcon />
            Done
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => remove.mutate({ id: schedule.id, itemId })}
            aria-label="Remove schedule"
          >
            <DeleteIcon />
          </Button>
        </div>
      </div>
      {schedule.basis === 'USAGE' ? (
        <div className="mt-2 flex items-end gap-2">
          <Input
            type="number"
            min={0}
            step="any"
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
            placeholder={`Log ${schedule.usageUnit ?? 'usage'}`}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={addUsage.isPending || !(Number(usage) > 0)}
            onClick={() =>
              addUsage.mutate(
                { id: schedule.id, itemId, amount: Number(usage) },
                { onSuccess: () => setUsage('') },
              )
            }
          >
            <SettingsIcon />
            Log usage
          </Button>
        </div>
      ) : null}
    </li>
  );
}
