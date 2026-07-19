/**
 * Consumable-Gauge concern (spec §4.1.2). Both the "Consumption" and "Weigh-In" UI
 * modes are normalised to a relative net-value delta before they reach the ledger,
 * the representation Phase 7's delta-CRDT reconciliation (§7.3) depends on.
 */
import { DbError } from '../../errors';
import {
  ATTRITION_PERCENT_BOUNDS,
  clampNetValue,
  isValidAttritionPercent,
  reconfigureNote,
  resolveGaugeReconfiguration,
  weighInNote,
  weighInToDelta,
  type GaugeConfigChange,
} from '../gauge';
import type { GaugeAdjustment, Item } from '../types';
import {
  gaugeAfterDelta,
  gaugeAfterRecapacity,
  gaugeDeltaHistoryStatement,
  gaugeValueUpdate,
  historyStatement,
} from './history';
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
     *
     * Both the write and the delta it records are **relative in SQL** (issue #297),
     * matching the quantity path (`stock_batches`): the delta is added to whatever the
     * row holds when the transaction runs, and the clamp is applied there too. Computing
     * the next value in JavaScript from a base read beforehand meant two overlapping
     * adjusts read the same base and the second write discarded the first, while the
     * ledger recorded both — leaving the gauge and the sum of its deltas permanently
     * disagreeing, which §7.3 replay then spreads to every device.
     */
    async adjustGauge(id: string, adjustment: GaugeAdjustment): Promise<Item> {
      this.assertPermission('stock:write');
      this.assertWritable();
      const existing = await this.require(id);
      if (existing.trackingMode !== 'CONSUMABLE_GAUGE' || !existing.gauge) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge adjustment applies only to CONSUMABLE_GAUGE items.');
      }
      if (!Number.isFinite(adjustment.delta)) {
        throw new DbError('SQLITE_CONSTRAINT', 'Gauge delta must be a finite number.');
      }

      // The prose and the attrition breakdown are composed here, from the value read above,
      // and so describe the gauge as it stood when the adjustment was made. That is the right
      // reading of a ledger note — it narrates the event — but it does mean an overlapping
      // adjust can leave the wording a little behind the row. Only the stored
      // `net_value_delta` has to be exact, and that one is derived in SQL below.
      const requestedNet = existing.gauge.currentNetValue + adjustment.delta;
      const nextNet = clampNetValue(requestedNet, existing.gauge.grossCapacity);
      const appliedDelta = nextNet - existing.gauge.currentNetValue;

      // A draw can be cut short by the gauge hitting empty. When that happens the attrition
      // breakdown describes an intent that only partly happened, so record the applied total
      // beside it and say so in the note — an append-only ledger must not assert that 110 g
      // left a gauge that only had 50 g in it.
      //
      // Compare the pre- and post-clamp net values, NOT the delta magnitudes: `clampNetValue`
      // returns its input unchanged when in range, so this is exact, whereas
      // `nextNet - currentNetValue` re-introduces float error on fractional draws and would
      // report a short draw on roughly a third of them.
      const clampedShort = requestedNet !== nextNet;
      const attritionMetadata = adjustment.attrition
        ? {
            attrition: {
              requested: adjustment.attrition.requested,
              waste: adjustment.attrition.waste,
              total: Math.abs(adjustment.delta),
              applied: Math.abs(appliedDelta),
            },
          }
        : undefined;

      const nextValue = gaugeAfterDelta(adjustment.delta);
      await this.driver.transaction([
        // The ledger entry goes first: its delta reads the pre-adjustment row.
        gaugeDeltaHistoryStatement(id, this.actorId(), nextValue, {
          ...(attritionMetadata ? { metadata: attritionMetadata } : {}),
          note:
            (adjustment.note ??
              `Gauge ${appliedDelta >= 0 ? '+' : ''}${appliedDelta}${existing.gauge.unitOfMeasure} (now ${nextNet}${existing.gauge.unitOfMeasure}).`) +
            (clampedShort && adjustment.attrition
              ? ` — only ${Math.abs(appliedDelta)}${existing.gauge.unitOfMeasure} was available.`
              : ''),
        }),
        gaugeValueUpdate(id, nextValue),
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
      this.assertPermission('stock:write');
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
      this.assertPermission('stock:write');
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
      // A null attrition clears the rate and is always valid; only a supplied number is
      // range-checked (issue #89).
      if (
        change.attritionPercent !== undefined &&
        change.attritionPercent !== null &&
        !isValidAttritionPercent(change.attritionPercent)
      ) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Attrition must be between ${ATTRITION_PERCENT_BOUNDS.min} and ${ATTRITION_PERCENT_BOUNDS.max} percent.`,
        );
      }

      const current = existing.gauge;
      const next = resolveGaugeReconfiguration(current, {
        // An omitted unit must stay omitted (leave it as-is), so only trim one that was given.
        unitOfMeasure: change.unitOfMeasure?.trim(),
        grossCapacity: change.grossCapacity,
        tareWeight: change.tareWeight,
        attritionPercent: change.attritionPercent,
      });
      if (!next.changed) return existing;

      // Re-clamp the *live* net value into the new capacity rather than writing back the
      // figure read above (issue #297). A reconfiguration changes what the gauge is, not
      // how much is in it, so an absolute write would silently revert any adjustment that
      // landed while the dialog was open — and on a pure relabel, where no spill is
      // expected, it would do so without leaving a ledger entry to explain it.
      const nextValue = gaugeAfterRecapacity(next.grossCapacity);

      // Whether a spill is *possible* decides whether the entry carries a delta — not
      // whether the pre-read happened to compute one, which a refill committing in between
      // can turn from zero into a real spill. A shrinking capacity can displace material;
      // so can an unchanged one that the stored level already exceeds (no CHECK enforces
      // `current_net_value <= gross_capacity`, so a synced row can arrive over-full). Where
      // neither holds, no clamp can bite and the entry carries no delta at all — zero would
      // be a meaningless ledger point on a pure relabel. The note always says what changed.
      const canSpill =
        next.grossCapacity < current.grossCapacity || current.currentNetValue > next.grossCapacity;
      await this.driver.transaction([
        // The ledger entry goes first: its delta reads the pre-reconfiguration row.
        canSpill
          ? gaugeDeltaHistoryStatement(id, this.actorId(), nextValue, {
              note: reconfigureNote(current, next),
            })
          : historyStatement(id, 'GAUGE_UPDATE', this.actorId(), {
              note: reconfigureNote(current, next),
            }),
        {
          sql: `UPDATE items
                SET unit_of_measure = ?, gross_capacity = ?, tare_weight = ?,
                    current_net_value = ${nextValue.sql},
                    attrition_percent = ?
                WHERE id = ?;`,
          params: [
            next.unitOfMeasure,
            next.grossCapacity,
            next.tareWeight,
            ...nextValue.params,
            next.attritionPercent,
            id,
          ],
        },
      ]);
      return (await this.getById(id))!;
    }
  };
}
