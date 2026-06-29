import type { Migration } from './migration';

/**
 * v11 — Automatic maintenance usage telemetry opt-in (spec §4.3, Phase 22).
 *
 * Phase 9 shipped USAGE-based maintenance schedules whose counter advanced only via a
 * *manually-entered* figure (`addUsage`); the §4.3 deferral noted that "a future phase
 * could drive usage_since_service from real events". Phase 22 does exactly that: a USAGE
 * schedule may opt in to accrue real **checkout-hours** — the loan duration of the tool
 * (a contact borrows it, returns it) counts toward its next service.
 *
 * The accrued hours are NOT stored: they are a *derived projection* over the `checkouts`
 * ledger (the §2.1 SSOT), summed at read time across the item's loans begun since the
 * last service, anchored on `last_performed_at ?? created_at` (mirroring the Phase-20
 * `inTransitQtyForItem` "derive, never store a counter" seam — so it can never drift
 * under check-in, revert, FK-cascade delete or LWW sync). The single thing that DOES
 * persist is the per-schedule *choice* to auto-accrue, so a single additive, NOT-NULL
 * boolean column (0/1) is the clean fit — no §2.3.3 12-step table recreation.
 *
 * It is a synced property of the schedule (a peer should see the same accrual mode), so
 * it deliberately joins the LWW payload automatically: `maintenance_schedules` is already
 * in `SYNC_TABLES` and the schema dictionary reads its columns live via `PRAGMA
 * table_info`, so the new column round-trips with no further registration.
 *
 * 0 = manual counter only (the Phase-9 behaviour); 1 = derive usage from checkout-hours
 * (the manual `addUsage` counter is then ignored in favour of the live projection).
 */
export const v11MaintenanceUsageTelemetry: Migration = {
  version: 11,
  name: 'maintenance-usage-telemetry',
  statements: [
    {
      sql: `ALTER TABLE maintenance_schedules ADD COLUMN accrue_checkout_hours INTEGER NOT NULL DEFAULT 0;`,
    },
  ],
};
