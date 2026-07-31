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

/**
 * InfoHint copy for the optional cost per unit of measure (issue #683), named after the gauge's
 * own unit so the field says what it prices rather than leaving it to be inferred.
 *
 * This is the **only** figure a gauge's stock can be valued from. *Unit cost* prices one
 * countable unit, and a gauge holds a measure rather than units — its quantity is always 0 — so
 * the ordinary `count × unit cost` product values a full cylinder at nothing however carefully it
 * was priced. The last line matters as much as the first: an unpriced gauge is *reported* as
 * unpriced, not quietly totalled as worthless, and the hint says which of the two is happening.
 *
 * A function rather than a constant because the unit varies per item; everything else about the
 * copy is fixed, for the same reason the constants above are shared — a user who reads one
 * explanation at creation and another at edit has been told two things about one column.
 */
export function gaugeCostHint(unit: string): string {
  return (
    `What **one ${unit}** of the contents costs, in your base currency.\n\n` +
    'This is what drives valuation for a gauge: it holds a *measure*, not a count of units, so ' +
    'its stock is worth **what is in it × this cost**.\n\n' +
    '> Leave it blank and the contents are reported as unpriced, rather than counted as worth ' +
    'nothing.'
  );
}
