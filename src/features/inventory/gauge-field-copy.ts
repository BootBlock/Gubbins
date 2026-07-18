/**
 * Shared field copy for the Consumable-Gauge configuration — the unit, full capacity and
 * tare (§4.1.1).
 *
 * The same three fields are collected twice: once in the Add-item dialog when the gauge is
 * first set up, and once in the item's **Gauge setup** editor when it is corrected later
 * (issue #69). Both must explain the fields identically — a user who reads "tare" one way
 * at creation and another way at edit has been told two different things about one column —
 * so the hint text lives here rather than being copied into each call site.
 */

/** InfoHint copy for the gauge's unit of measure. */
export const GAUGE_UNIT_HINT =
  'The unit the gauge is measured in — `g`, `ml`, `m`, etc. This labels the capacity and ' +
  'remaining amounts everywhere.';

/** InfoHint copy for the gauge's full (gross) capacity. */
export const GAUGE_CAPACITY_HINT =
  'The **gross** amount a brand-new/full unit holds, in the unit above — including any ' +
  'container. The gauge reads *empty* at the tare and *full* here.';

/** InfoHint copy for the gauge's tare (empty-container) weight. */
export const GAUGE_TARE_HINT =
  'The weight of the **empty container** (the spool, bottle or reel). Subtracted from a ' +
  'measured gross weight so the gauge reflects only the *usable contents*. Use `0` if not weighing.';

/**
 * The tare hint as shown when *editing* an existing gauge. Identical to
 * {@link GAUGE_TARE_HINT} up to the last sentence, which answers the question only an edit
 * raises: re-taring changes what a scale is expected to read, not how much is in the gauge.
 */
export const GAUGE_TARE_EDIT_HINT =
  'The weight of the **empty container** (the spool, bottle or reel). Subtracted from a ' +
  'measured gross weight so the gauge reflects only the *usable contents*. Changing it ' +
  're-scales future weigh-ins; it does not change how much is in the gauge now.';

/**
 * InfoHint copy for the optional attrition rate (issue #89). Deliberately leads with the
 * worked example — "attrition" is jargon, but "take 100 g, lose 110 g" is not.
 */
export const GAUGE_ATTRITION_HINT =
  'Extra material lost every time you use some — trimmings, spillage, dust. At `10%`, ' +
  'recording `100` used takes `110` off the gauge. Leave blank if nothing is wasted. ' +
  'Only applies when you record an amount used; a weigh-in already measures what is left.';
