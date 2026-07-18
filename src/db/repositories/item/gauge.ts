/**
 * Consumable-Gauge concern (spec §4.1.2). Both the "Consumption" and "Weigh-In" UI
 * modes are normalised to a relative net-value delta before they reach the ledger,
 * the representation Phase 7's delta-CRDT reconciliation (§7.3) depends on.
 */
import { DbError } from '../../errors';
import {
  clampNetValue,
  reconfigureNote,
  resolveGaugeReconfiguration,
  weighInNote,
  weighInToDelta,
  type GaugeConfigChange,
} from '../gauge';
import type { GaugeAdjustment, Item } from '../types';
import { historyStatement } from './history';
import type { Constructor } from './mixin';
import type { ItemCoreRepository } from './core';

export function withGauge<TBase extends Constructor<ItemCoreRepository>>(Base: TBase) {
  return class ItemGaugeRepository extends Base {
    /**
     * Apply a Consumable-Gauge adjustment as a relative delta (spec §4.1.2). Both
     * "Consumption" and "Weigh-In" UI modes are normalised to a delta *before*
     * reaching here, so the ledger only ever stores relative net-value deltas — the
     * representation Phase 7's delta-CRDT reconciliation (§7.3) depends on. The new
     * net value is clamped to the valid range `[0, grossCapacity]` — it can never go
     * below empty nor (after a refill/overfilled weigh-in) above a full unit.
     */
    async adjustGauge(id: string, adjustment: GaugeAdjustment): Promise<Item> {
      this.assertWritable();
      const existing = await this.require(id);
      if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge adjustment applies only to CONSUMABLE_GAUGE items.');
      }
      if (!Number.isFinite(adjustment.delta)) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge delta must be a finite number.');
      }

      const requestedNet = existing.gauge.currentNetValue + adjustment.delta;
      const nextNet = clampNetValue(requestedNet, existing.gauge.grossCapacity);
      const appliedDelta = nextNet - existing.gauge.currentNetValue;

      await this.driver.transaction([
        { sql: 'UPDATE items SET current_net_value = ? WHERE id = ?;', params: [nextNet, id] },
        historyStatement(id, 'GAUGE_UPDATE', {
          netValueDelta: appliedDelta,
          note:
            adjustment.note ??
            `Gauge ${appliedDelta >= 0 ? '+' : ''}${appliedDelta}${existing.gauge.unitOfMeasure} (now ${nextNet}${existing.gauge.unitOfMeasure}).`,
        }),
      ]);
      return (await this.getById(id))!;
    }

    /**
     * Convenience for an Absolute "Weigh-In" (§4.1.2): converts the gross weight on
     * the scale into a relative delta here so call sites cannot accidentally store an
     * absolute value. (The production UI converts in the React layer; this guards
     * the repository contract and is exercised by the gauge tests.)
     */
    async weighInGauge(id: string, grossWeightOnScale: number): Promise<Item> {
      const existing = await this.require(id);
      if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
        throw new DbError('SQLITE_CONSTRAINT', 'Weigh-in applies only to CONSUMABLE_GAUGE items.');
      }
      const delta = weighInToDelta(
        grossWeightOnScale,
        existing.gauge.currentNetValue,
        existing.gauge.tareWeight,
      );
      return this.adjustGauge(id, {
        delta,
        note: weighInNote(grossWeightOnScale, delta, existing.gauge.unitOfMeasure),
      });
    }

    /**
     * Correct a gauge's *configuration* — its unit of measure, full capacity and tare
     * (issue #69). Unlike `adjustGauge`, which records material moving in or out, this
     * changes what the gauge **is**: the drum was always 100 m and was mistyped as 100 g,
     * or a fresh spool with a different empty weight has been mounted.
     *
     * These three columns were previously write-once at creation, so the only way to fix
     * them was to delete the item and recreate it — throwing away its Activity Log and
     * every reference to it. Editing them in place keeps that history intact.
     *
     * Capacity is the one field that can invalidate stored state: `current_net_value` may
     * never exceed it (§4.1.1), so shrinking a gauge below its current level spills the
     * excess, and that spill is written as a relative `netValueDelta` — never an absolute
     * level — to preserve the delta-CRDT invariant (§7.3).
     */
    async reconfigureGauge(id: string, change: GaugeConfigChange): Promise<Item> {
      this.assertWritable();
      const existing = await this.require(id);
      if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge configuration applies only to CONSUMABLE_GAUGE items.');
      }

      // Mirror the v1 CHECK constraints with readable messages rather than letting a raw
      // SQLITE_CONSTRAINT surface: unit non-empty, capacity strictly positive, tare >= 0.
      if (change.unitOfMeasure !== undefined && change.unitOfMeasure.trim().length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A gauge must have a unit of measure.');
      }
      if (
        change.grossCapacity !== undefined &&
        !(Number.isFinite(change.grossCapacity) && change.grossCapacity > 0)
      ) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge capacity must be a number greater than zero.');
      }
      if (
        change.tareWeight !== undefined &&
        !(Number.isFinite(change.tareWeight) && change.tareWeight >= 0)
      ) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge tare weight must be zero or a positive number.');
      }

      const current = existing.gauge;
      const next = resolveGaugeReconfiguration(current, {
        // An omitted unit must stay omitted (leave it as-is), so only trim one that was given.
        unitOfMeasure: change.unitOfMeasure?.trim(),
        grossCapacity: change.grossCapacity,
        tareWeight: change.tareWeight,
      });
      if (!next.changed) return existing;

      await this.driver.transaction([
        {
          sql: `UPDATE items
                SET unit_of_measure = ?, gross_capacity = ?, tare_weight = ?, current_net_value = ?
                WHERE id = ?;`,
          params: [next.unitOfMeasure, next.grossCapacity, next.tareWeight, next.currentNetValue, id],
        },
        historyStatement(id, 'GAUGE_UPDATE', {
          // Zero would be a meaningless ledger point on a pure relabel, so only a real
          // spill carries a delta; the note always says what changed.
          ...(next.netValueDelta !== 0 ? { netValueDelta: next.netValueDelta } : {}),
          note: reconfigureNote(current, next),
        }),
      ]);
      return (await this.getById(id))!;
    }
  };
}
