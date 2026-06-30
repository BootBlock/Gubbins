/**
 * MaintenanceRepository (spec §4.3 Tool Maintenance & Calibration, Phase 9).
 *
 * Encapsulates all SQL for `maintenance_schedules` over the injected driver. A
 * schedule fires on elapsed `TIME` (days) or accrued `USAGE` (a manually-logged
 * counter). "Due-ness" is *computed* by the pure {@link maintenanceStatus} module,
 * never stored — so reads return the raw schedule and the UI/dashboard classify it
 * with an injected `now`. Performing a service is recorded in the item's immutable
 * Activity Log (`MAINTENANCE_LOGGED`) in the same transaction as the schedule reset.
 *
 * `maintenance_schedules` participates in synchronisation (it carries its own
 * `updated_at`), so a hard delete records a tombstone in the same transaction (§7.2).
 */
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository } from './base';
import { rowToMaintenanceSchedule } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  CreateMaintenanceInput,
  MaintenanceSchedule,
  MaintenanceScheduleRow,
  MaintenanceScheduleWithItem,
  Page,
  PageParams,
} from './types';

/**
 * SQL fragment yielding the instant a TIME schedule falls due (UNIX-ms), qualified
 * to the `ms` alias used by the join queries: it is due once
 * `COALESCE(last_performed_at, created_at) + interval_days·86 400 000 ≤ now`.
 */
const TIME_DUE_AT = `(COALESCE(ms.last_performed_at, ms.created_at) + ms.interval_days * 86400000)`;

/**
 * Derived checkout-hours accrued to a schedule since its service anchor (§4.3, Phase 22).
 * A *projection* over the `checkouts` ledger (the §2.1 SSOT), never a stored counter: the
 * sum, in hours, of every loan of the item *begun* at or after `last_performed_at`
 * (or `created_at` if never serviced), each open loan accruing up to `now`. `MAX(0, …)`
 * clamps any clock-skewed window so it cannot subtract usage. Only accrue-mode schedules
 * compute it; others read 0. The single `?` binds `now` (UNIX ms).
 *
 * When the schedule is location-scoped (`location_id` set, Phase 30), only loans drawn
 * *from that placement* (`checkouts.source_location_id`, Phase 26) accrue toward it, so each
 * placement's wear is attributed to its own service clock; an item-level schedule
 * (`location_id IS NULL`) accrues every loan, exactly as before — mirroring the pure
 * `accruedCheckoutHours` scope filter.
 */
const AUTO_USAGE_HOURS = `(CASE WHEN ms.accrue_checkout_hours = 1 THEN (
     SELECT COALESCE(SUM(MAX(0, COALESCE(k.returned_at, ?) - k.checked_out_at) / 3600000.0), 0)
     FROM checkouts k
     WHERE k.item_id = ms.item_id
       AND k.checked_out_at >= COALESCE(ms.last_performed_at, ms.created_at)
       AND (ms.location_id IS NULL OR k.source_location_id = ms.location_id)
   ) ELSE 0 END)`;

/**
 * The usage figure a USAGE schedule is measured against in SQL: the derived
 * checkout-hours when it auto-accrues, else the manually-logged counter. Mirrors the
 * pure `effectiveUsage`; its embedded {@link AUTO_USAGE_HOURS} binds `now` once.
 */
const EFFECTIVE_USAGE = `(CASE WHEN ms.accrue_checkout_hours = 1 THEN ${AUTO_USAGE_HOURS} ELSE ms.usage_since_service END)`;

export class MaintenanceRepository extends BaseRepository {
  /** All schedules for an item, oldest first (stable display order). */
  async listForItem(itemId: string, now: number = Date.now()): Promise<MaintenanceSchedule[]> {
    const rows = await this.driver.query<MaintenanceScheduleRow>(
      `SELECT ms.*, ${AUTO_USAGE_HOURS} AS auto_usage_hours, sl.name AS location_name
       FROM maintenance_schedules ms
       LEFT JOIN locations sl ON sl.id = ms.location_id
       WHERE ms.item_id = ? ORDER BY ms.created_at ASC;`,
      [now, itemId],
    );
    return rows.map(rowToMaintenanceSchedule);
  }

  async getById(id: string, now: number = Date.now()): Promise<MaintenanceSchedule | undefined> {
    const row = await this.driver.queryOne<MaintenanceScheduleRow>(
      `SELECT ms.*, ${AUTO_USAGE_HOURS} AS auto_usage_hours, sl.name AS location_name
       FROM maintenance_schedules ms
       LEFT JOIN locations sl ON sl.id = ms.location_id
       WHERE ms.id = ?;`,
      [now, id],
    );
    return row ? rowToMaintenanceSchedule(row) : undefined;
  }

  /**
   * Schedules that are currently due or overdue (spec §4.3 alerts → §3 dashboard
   * widget), joined with the item name and scoped to active items. `now` is injected
   * so the read is deterministic. TIME schedules are due once
   * `COALESCE(last_performed_at, created_at) + interval` ≤ now; USAGE schedules once
   * `usage_since_service` ≥ `interval_usage`. Ordered most-overdue first.
   */
  async listDue(now: number, params: PageParams = {}): Promise<Page<MaintenanceScheduleWithItem>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<MaintenanceScheduleRow & { item_name: string }>(
      `SELECT ms.*, ${AUTO_USAGE_HOURS} AS auto_usage_hours, items.name AS item_name, sl.name AS location_name
       FROM maintenance_schedules ms
       JOIN items ON items.id = ms.item_id
       LEFT JOIN locations sl ON sl.id = ms.location_id
       WHERE items.is_active = 1
         AND (
           (ms.basis = 'TIME'  AND ${TIME_DUE_AT} <= ?)
           OR (ms.basis = 'USAGE' AND ${EFFECTIVE_USAGE} >= ms.interval_usage)
         )
       ORDER BY
         CASE WHEN ms.basis = 'TIME' THEN ${TIME_DUE_AT} ELSE 0 END ASC
       LIMIT ? OFFSET ?;`,
      [now, now, now, limit, offset],
    );
    const mapped = rows.map((row) => ({
      ...rowToMaintenanceSchedule(row),
      itemName: row.item_name,
    }));
    return this.toPage(mapped, limit, offset);
  }

  /**
   * Every active-item schedule joined with its item name (Phase 75, the unified "Upcoming"
   * agenda). Read-only: unlike {@link listDue} this returns schedules whether or not they are
   * yet due, so the agenda can show **future** TIME due dates as well as overdue ones. The pure
   * `agenda.ts` seam derives each TIME schedule's calendar due instant and decides USAGE
   * due-ness (a USAGE schedule has no calendar date, so it only appears once actually due).
   * `now` is injected purely to evaluate the derived checkout-hours; TIME schedules sort
   * soonest-first so a bounded read captures the nearest dates. No schema change.
   */
  async listUpcoming(now: number, params: PageParams = {}): Promise<Page<MaintenanceScheduleWithItem>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<MaintenanceScheduleRow & { item_name: string }>(
      `SELECT ms.*, ${AUTO_USAGE_HOURS} AS auto_usage_hours, items.name AS item_name, sl.name AS location_name
       FROM maintenance_schedules ms
       JOIN items ON items.id = ms.item_id
       LEFT JOIN locations sl ON sl.id = ms.location_id
       WHERE items.is_active = 1
       ORDER BY
         CASE WHEN ms.basis = 'TIME' THEN 0 ELSE 1 END ASC,
         CASE WHEN ms.basis = 'TIME' THEN ${TIME_DUE_AT} ELSE 0 END ASC
       LIMIT ? OFFSET ?;`,
      [now, limit, offset],
    );
    const mapped = rows.map((row) => ({
      ...rowToMaintenanceSchedule(row),
      itemName: row.item_name,
    }));
    return this.toPage(mapped, limit, offset);
  }

  /** Count of currently due/overdue schedules (for the dashboard badge). */
  async countDue(now: number): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM maintenance_schedules ms
       JOIN items ON items.id = ms.item_id
       WHERE items.is_active = 1
         AND ((ms.basis = 'TIME' AND ${TIME_DUE_AT} <= ?)
           OR (ms.basis = 'USAGE' AND ${EFFECTIVE_USAGE} >= ms.interval_usage));`,
      [now, now],
    );
    return Number(row?.n ?? 0);
  }

  /** Create a maintenance schedule for an item (spec §4.3). Write-gated. */
  async create(input: CreateMaintenanceInput): Promise<MaintenanceSchedule> {
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A maintenance schedule must have a name.');
    }
    let intervalDays: number | null = null;
    let intervalUsage: number | null = null;
    let usageUnit: string | null = null;
    // A TIME schedule is never loan-driven; accrual is a USAGE-only concept (§4.3).
    let accrueCheckoutHours = false;
    if (input.basis === 'TIME') {
      intervalDays = input.intervalDays ?? null;
      if (!Number.isFinite(intervalDays ?? NaN) || (intervalDays as number) <= 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A time-based schedule needs a positive interval in days.');
      }
      intervalDays = Math.trunc(intervalDays as number);
    } else {
      intervalUsage = input.intervalUsage ?? null;
      if (!Number.isFinite(intervalUsage ?? NaN) || (intervalUsage as number) <= 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A usage-based schedule needs a positive usage interval.');
      }
      accrueCheckoutHours = input.accrueCheckoutHours === true;
      // When auto-accruing, the interval is necessarily measured in hours; default the
      // label so the UI reads naturally without forcing the user to type it.
      usageUnit = input.usageUnit?.trim() || (accrueCheckoutHours ? 'hours' : null);
    }

    // A scope location (Phase 30) is optional; empty/absent → an item-level schedule (NULL).
    const locationId = input.locationId || null;

    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO maintenance_schedules
         (id, item_id, name, basis, interval_days, interval_usage, usage_unit, accrue_checkout_hours, location_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id, input.itemId, name, input.basis, intervalDays, intervalUsage, usageUnit,
        accrueCheckoutHours ? 1 : 0, locationId, input.note?.trim() || null,
      ],
    );
    return (await this.getById(id))!;
  }

  /**
   * Record that a service was performed (spec §4.3): reset the schedule's clock
   * (`last_performed_at = now`, `usage_since_service = 0`) and append a
   * `MAINTENANCE_LOGGED` entry to the item's Activity Log in the same transaction.
   * The ledger note is composed upstream. Write-gated (it grows the ledger).
   */
  async logPerformed(id: string, now: number, note: string): Promise<MaintenanceSchedule> {
    this.assertWritable();
    const schedule = await this.requireSchedule(id);
    await this.driver.transaction([
      {
        sql: 'UPDATE maintenance_schedules SET last_performed_at = ?, usage_since_service = 0 WHERE id = ?;',
        params: [now, id],
      },
      {
        sql: `INSERT INTO item_history (id, item_id, action, note, metadata)
              VALUES (?, ?, 'MAINTENANCE_LOGGED', ?, ?);`,
        params: [crypto.randomUUID(), schedule.itemId, note, JSON.stringify({ scheduleId: id })],
      },
    ]);
    return (await this.getById(id))!;
  }

  /** Accrue usage against a USAGE schedule's counter (spec §4.3). Write-gated. */
  async addUsage(id: string, amount: number): Promise<MaintenanceSchedule> {
    this.assertWritable();
    const schedule = await this.requireSchedule(id);
    if (schedule.basis !== 'USAGE') {
      throw new DbError('SQLITE_CONSTRAINT', 'Usage can only be logged against a usage-based schedule.');
    }
    if (schedule.accrueCheckoutHours) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'This schedule accrues checkout-hours automatically; usage cannot be logged manually.',
      );
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'Logged usage must be a positive number.');
    }
    await this.driver.execute(
      'UPDATE maintenance_schedules SET usage_since_service = usage_since_service + ? WHERE id = ?;',
      [amount, id],
    );
    return (await this.getById(id))!;
  }

  /**
   * Hard-delete a schedule (spec §7.2): removes the row and records a tombstone in
   * the same transaction so the deletion propagates on the next sync. A delete, so
   * it bypasses the storage Hard Stop.
   */
  async remove(id: string): Promise<void> {
    const statements: SqlStatement[] = [
      { sql: 'DELETE FROM maintenance_schedules WHERE id = ?;', params: [id] as SqlValue[] },
      tombstoneStatement('maintenance_schedules', id),
    ];
    await this.driver.transaction(statements);
  }

  private async requireSchedule(id: string): Promise<MaintenanceSchedule> {
    const schedule = await this.getById(id);
    if (!schedule) {
      throw new DbError('SQLITE_CONSTRAINT', `Maintenance schedule "${id}" does not exist.`);
    }
    return schedule;
  }
}
