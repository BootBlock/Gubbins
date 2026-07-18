/**
 * Small pure display helpers for naming an item in the UI.
 *
 * Kept apart from `labels/` (which builds *physical* printed labels) — this is about how an item
 * reads in a list, a picker or a sentence.
 */

/**
 * How an item reads when named on its own: `Name`, or `Name #serial` for a serialised clone —
 * the instance number is what distinguishes one unit from its identical siblings, so a bare name
 * would be ambiguous wherever several clones can appear together.
 *
 * Tolerates a nullish `serialNo` rather than testing `=== null`: the column is `number | null`,
 * but partially-built fixtures and rows read through looser shapes can carry `undefined`, and
 * rendering a literal "#undefined" to a user is far worse than treating it as "not serialised".
 */
export function itemDisplayName(name: string, serialNo: number | null | undefined): string {
  return serialNo == null ? name : `${name} #${serialNo}`;
}
