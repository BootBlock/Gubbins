/**
 * Item-detail facet for Tool Maintenance Schedules (spec §4.3). Lists an item's
 * schedules with their *computed* due status (the pure `maintenanceStatus` maths,
 * never stored), and lets the user add a schedule, log a performed service (which
 * resets the schedule and appends a `MAINTENANCE_LOGGED` ledger entry), accrue
 * usage against a usage-based schedule, or remove one.
 */
import { useState } from 'react';
import { Button, InfoHint, Input, Select, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { SettingsIcon, AddIcon, DeleteIcon, CheckIcon, WarningIcon } from '@/components/icons';
import { MAINTENANCE_BASES, type MaintenanceBasis, type MaintenanceSchedule } from '@/db/repositories';
import { cn } from '@/lib/utils';
import { MAINTENANCE_BASIS_LABELS } from '@/features/inventory/components/inventory-ui';
import {
  maintenanceStatus,
  maintenancePerformedNote,
  type MaintenanceScheduleState,
} from '../maintenance';
import {
  useAddMaintenanceUsage,
  useCreateMaintenance,
  useItemMaintenance,
  useItemStock,
  useLogMaintenance,
  useRemoveMaintenance,
} from '../hooks';

/** Sentinel for the "whole item" picker option (distinct from any location id). */
const WHOLE_ITEM = '';

export function MaintenanceEditor({ itemId }: { itemId: string }) {
  const { data: schedules } = useItemMaintenance(itemId);
  const { data: placements } = useItemStock(itemId);
  const create = useCreateMaintenance();
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<MaintenanceBasis>('TIME');
  const [interval, setInterval] = useState('90');
  const [usageUnit, setUsageUnit] = useState('hours');
  const [accrueCheckoutHours, setAccrueCheckoutHours] = useState(false);
  const [locationId, setLocationId] = useState<string>(WHOLE_ITEM);
  const [error, setError] = useState<string | null>(null);

  // Offer a per-placement scope only where the tool actually sits in more than one place
  // (Phase 30, §4.3): a schedule scoped to a location is serviced per placement.
  const scopeLocations = placements ?? [];
  const showLocationScope = scopeLocations.length > 1;

  const add = () => {
    if (name.trim().length === 0) return;
    setError(null);
    // A scope is only meaningful when offered; otherwise the schedule stays item-level.
    const scope = showLocationScope && locationId !== WHOLE_ITEM ? locationId : null;
    const input =
      basis === 'TIME'
        ? { itemId, name: name.trim(), basis, intervalDays: Number(interval), locationId: scope }
        : {
            itemId,
            name: name.trim(),
            basis,
            intervalUsage: Number(interval),
            // Auto-accrual is measured in hours; the unit field is hidden in that mode.
            usageUnit: accrueCheckoutHours ? 'hours' : usageUnit.trim() || null,
            accrueCheckoutHours,
            locationId: scope,
          };
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
          <InfoHint
            content={
              'A recurring service for this item (e.g. *lubricate rails*, *recalibrate*). Pick a ' +
              '**basis**:\n\n' +
              '- **Time** — every N **days** (e.g. calibrate every 90 days).\n' +
              '- **Usage** — every N units of use; tick *accrue checkout hours* to count loan time ' +
              'automatically instead of logging it by hand.\n\n' +
              'When due, the item flags up; logging a service **resets the clock** and records it in ' +
              'the **Activity log**.'
            }
          />
        </p>
        <div className="space-y-2">
          <Input
            data-testid="maintenance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lubricate rails"
          />
          <div className="grid grid-cols-3 gap-2">
            <Select
              data-testid="maintenance-basis"
              value={basis}
              onChange={(e) => setBasis(e.target.value as MaintenanceBasis)}
            >
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
              accrueCheckoutHours ? (
                <span className="self-center text-xs text-muted-foreground">hours</span>
              ) : (
                <Input value={usageUnit} onChange={(e) => setUsageUnit(e.target.value)} placeholder="hours" />
              )
            ) : (
              <span className="self-center text-xs text-muted-foreground">days</span>
            )}
          </div>
          {basis === 'USAGE' ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                data-testid="accrue-checkout-hours"
                checked={accrueCheckoutHours}
                onChange={(e) => setAccrueCheckoutHours(e.target.checked)}
                className="size-4 accent-primary"
              />
              Accrue checkout hours automatically
              <Tooltip
                content="Usage is derived from how long this tool is checked out — no manual logging needed."
                openDelayMs={INFO_OPEN_DELAY_MS}
              >
                <span className="cursor-help underline decoration-dotted">why?</span>
              </Tooltip>
            </label>
          ) : null}
          {showLocationScope ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">Applies to</span>
              <Select
                data-testid="maintenance-location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value={WHOLE_ITEM}>Whole item (any location)</option>
                {scopeLocations.map((p) => (
                  <option key={p.locationId} value={p.locationId}>
                    {p.locationName}
                  </option>
                ))}
              </Select>
              <Tooltip
                content="Scope this schedule to one placement — serviced per location, and (in accrue mode) counting only loans drawn from there."
                openDelayMs={INFO_OPEN_DELAY_MS}
              >
                <span className="cursor-help underline decoration-dotted">why?</span>
              </Tooltip>
            </label>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" onClick={add} disabled={create.isPending} data-testid="add-maintenance">
              Add schedule
            </Button>
          </div>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
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

  const state: MaintenanceScheduleState = {
    basis: schedule.basis,
    intervalDays: schedule.intervalDays,
    intervalUsage: schedule.intervalUsage,
    usageSinceService: schedule.usageSinceService,
    accrueCheckoutHours: schedule.accrueCheckoutHours,
    autoUsage: schedule.autoUsageHours,
    lastPerformedAt: schedule.lastPerformedAt,
    createdAt: schedule.createdAt,
  };
  const status = maintenanceStatus(state, Date.now());

  const usageDetail = schedule.accrueCheckoutHours
    ? `every ${schedule.intervalUsage} hours · ${schedule.autoUsageHours.toFixed(1)}h from loans`
    : `every ${schedule.intervalUsage} ${schedule.usageUnit ?? 'units'} · ${schedule.usageSinceService} logged`;
  const detail =
    schedule.basis === 'TIME'
      ? `every ${schedule.intervalDays} days${
          status.remainingDays !== null
            ? status.due
              ? ` · ${-status.remainingDays} day(s) overdue`
              : ` · ${status.remainingDays} day(s) left`
            : ''
        }`
      : usageDetail;

  const performed = () =>
    log.mutate({
      id: schedule.id,
      itemId,
      note: maintenancePerformedNote(schedule.name, state, Date.now()),
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
            {schedule.locationName ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                @ {schedule.locationName}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip
            content="Marks this service as just performed — **resets** the schedule's clock and records a `MAINTENANCE_LOGGED` entry in the item's history."
            triggerTabIndex={-1}
          >
            <span>
              <Button size="sm" variant="outline" onClick={performed} disabled={log.isPending} data-testid="log-maintenance">
                <CheckIcon />
                Done
              </Button>
            </span>
          </Tooltip>
          <Tooltip content="Delete this maintenance schedule. Past service history is kept." triggerTabIndex={-1}>
            <span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove.mutate({ id: schedule.id, itemId })}
                aria-label="Remove schedule"
              >
                <DeleteIcon className="text-glyph-danger" />
              </Button>
            </span>
          </Tooltip>
        </div>
      </div>
      {schedule.basis === 'USAGE' ? (
        schedule.accrueCheckoutHours ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
            <SettingsIcon />
            Usage accrues automatically from checkout hours.
          </p>
        ) : (
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
        )
      ) : null}
    </li>
  );
}
