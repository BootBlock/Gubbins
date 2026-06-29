/**
 * Consumable-Gauge concern (spec §4.1.2). Both the "Consumption" and "Weigh-In" UI
 * modes are normalised to a relative net-value delta before they reach the ledger,
 * the representation Phase 7's delta-CRDT reconciliation (§7.3) depends on.
 */
import { DbError } from '../../errors';
import { clampNetValue, weighInNote, weighInToDelta } from '../gauge';
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
        throw new DbError(
          'SQLITE_CONSTRAINT',
          'Gauge adjustment applies only to CONSUMABLE_GAUGE items.',
        );
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
  };
}
