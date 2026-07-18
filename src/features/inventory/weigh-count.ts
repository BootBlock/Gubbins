/**
 * Weight-to-count translation (issue #101) — the pure arithmetic behind "count a handful of
 * small parts by putting them on a scale" rather than counting them by hand.
 *
 * The item already carries an intrinsic per-unit mass (`items.weight`, canonically **grams**
 * — see `lib/weight.ts` and issue #25). Given a gross weight read off a scale and the tare of
 * whatever the parts are sitting in, the net mass divided by that per-unit mass is the number
 * of units on the scale.
 *
 * Every value crossing this seam is in **grams**, so the caller converts once at the edges
 * using the user's `weightUnit` preference exactly as the formatter does — the maths never
 * sees a display unit.
 *
 * Side-effect-free (no React, no DB) so the arithmetic and, in particular, the *confidence*
 * banding are unit-tested in isolation. The confidence band matters more than the division:
 * a scale reading is never exact, and quietly rounding 43.0 g of 0.5 g screws to "86" is only
 * honest if the reading actually lands near a whole number of units. When it doesn't, the
 * caller must say so rather than present a fabricated count as fact.
 */

/** A resolved weigh-in: what the scale implies, and how much to trust it. */
export interface WeighCountResult {
  /** Net mass on the scale in grams (gross − tare), clamped at zero. */
  readonly netGrams: number;
  /** The raw, unrounded quotient `netGrams / unitWeightGrams`. */
  readonly exactUnits: number;
  /** The whole-unit count the net mass implies (nearest whole number, never negative). */
  readonly count: number;
  /**
   * How far {@link exactUnits} sits from {@link count}, in units (0 … 0.5). This is the
   * quantity the confidence band is drawn from — it is the *fractional* part of a unit the
   * reading is off by, not a mass, so it stays meaningful for both 0.5 g screws and 2 kg
   * castings.
   */
  readonly deviationUnits: number;
  /** Confidence band for {@link count} — see {@link classifyDeviation}. */
  readonly confidence: WeighCountConfidence;
}

/**
 * How well the reading lines up with a whole number of units:
 *
 * - `exact` — within 5% of a unit; the reading is essentially a whole number of items.
 * - `close` — within 25% of a unit; almost certainly right, but the scale, a damp part or a
 *   slightly-off unit weight has nudged it. Worth showing the user the deviation.
 * - `uncertain` — more than 25% of a unit out. The count is the best guess available, but
 *   something is wrong: the tare, the recorded unit weight, or a stray part in the tray. The
 *   UI must warn rather than present the number as settled.
 */
export type WeighCountConfidence = 'exact' | 'close' | 'uncertain';

/** Deviation (in units) at or below which a reading is treated as landing on a whole unit. */
export const EXACT_DEVIATION_UNITS = 0.05;

/** Deviation (in units) above which a reading is no longer trustworthy. */
export const CLOSE_DEVIATION_UNITS = 0.25;

/** Band a unit-space deviation (0 … 0.5) into a {@link WeighCountConfidence}. */
export function classifyDeviation(deviationUnits: number): WeighCountConfidence {
  if (!Number.isFinite(deviationUnits) || deviationUnits > CLOSE_DEVIATION_UNITS) return 'uncertain';
  return deviationUnits <= EXACT_DEVIATION_UNITS ? 'exact' : 'close';
}

/**
 * Translate a scale reading into a unit count. Returns `null` when the inputs can't support a
 * count at all — a non-finite or non-positive per-unit weight (dividing by it is meaningless)
 * or a non-finite gross/tare reading. A *negative* net (tare heavier than the gross reading,
 * i.e. the user mistyped one of them) is not an error here: it clamps to an empty scale, and
 * the caller decides how loudly to say so.
 */
export function countFromWeight({
  grossGrams,
  tareGrams = 0,
  unitWeightGrams,
}: {
  readonly grossGrams: number;
  readonly tareGrams?: number;
  readonly unitWeightGrams: number;
}): WeighCountResult | null {
  if (!Number.isFinite(grossGrams) || !Number.isFinite(tareGrams)) return null;
  if (!Number.isFinite(unitWeightGrams) || unitWeightGrams <= 0) return null;

  const netGrams = Math.max(0, grossGrams - tareGrams);
  const exactUnits = netGrams / unitWeightGrams;
  const count = Math.max(0, Math.round(exactUnits));
  const deviationUnits = Math.abs(exactUnits - count);

  return { netGrams, exactUnits, count, deviationUnits, confidence: classifyDeviation(deviationUnits) };
}

/**
 * What is wrong with a pair of entered weights, when anything is. Distinguished so the UI can
 * put the message on the *field that is wrong* rather than reporting every bad entry as the
 * same generic failure — in particular, a negative reading is the user's own typo and must not
 * be blamed on a container they never entered.
 */
export type WeighCountIssue = 'unreadable' | 'gross-negative' | 'tare-negative' | 'tare-too-heavy';

/** A fully-resolved weigh-in entry: the count, what (if anything) is wrong, and the stock delta. */
export interface ResolvedWeighCount {
  readonly result: WeighCountResult | null;
  readonly issue: WeighCountIssue | null;
  /** Change to apply to the recorded quantity; zero whenever there is nothing to apply. */
  readonly delta: number;
}

/**
 * Validate and resolve an entered weigh-in against the recorded stock. Splitting this out of the
 * component keeps the *order* of the checks — which is what decides which field gets blamed —
 * under test rather than buried in JSX.
 *
 * `grossBlank` is passed separately because an empty field is not an error: the dialog opens with
 * nothing typed and must not greet the user with a validation message.
 */
export function resolveWeighCount({
  grossGrams,
  tareGrams,
  unitWeightGrams,
  quantity,
  grossBlank,
}: {
  readonly grossGrams: number;
  readonly tareGrams: number;
  readonly unitWeightGrams: number;
  readonly quantity: number;
  readonly grossBlank: boolean;
}): ResolvedWeighCount {
  const nothing = { result: null, delta: 0 } as const;
  if (grossBlank) return { ...nothing, issue: null };
  if (!Number.isFinite(grossGrams) || !Number.isFinite(tareGrams)) {
    return { ...nothing, issue: 'unreadable' };
  }
  // Checked before the comparison below: a negative reading with no tare would otherwise satisfy
  // `gross < tare` (0) and be reported as a container problem that does not exist.
  if (grossGrams < 0) return { ...nothing, issue: 'gross-negative' };
  if (tareGrams < 0) return { ...nothing, issue: 'tare-negative' };
  if (grossGrams < tareGrams) return { ...nothing, issue: 'tare-too-heavy' };

  const result = countFromWeight({ grossGrams, tareGrams, unitWeightGrams });
  if (!result) return { ...nothing, issue: 'unreadable' };
  return { result, issue: null, delta: result.count - quantity };
}

/**
 * Activity-log note for a weigh-in, so the history records *how* the quantity was arrived at
 * rather than an unexplained jump. Mirrors `gauge.ts`'s `weighInNote`: the reading and the
 * resulting delta, in the units the user actually read them in.
 *
 * `formatWeight` is injected (rather than imported) so this stays free of the reactive
 * formatter bundle and remains a pure, locale-agnostic function under test.
 */
export function weighCountNote({
  grossGrams,
  tareGrams,
  count,
  delta,
  formatWeight,
}: {
  readonly grossGrams: number;
  readonly tareGrams: number;
  readonly count: number;
  readonly delta: number;
  readonly formatWeight: (grams: number) => string;
}): string {
  const tare = tareGrams > 0 ? `, tare ${formatWeight(tareGrams)}` : '';
  const signed = `${delta > 0 ? '+' : ''}${delta}`;
  return `Counted by weight: ${formatWeight(grossGrams)} on scale${tare} → ${count} units (${signed})`;
}
