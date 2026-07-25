/**
 * Picker options for the Visual Builder's fixed-vocabulary (`enum`) fields — condition,
 * tracking mode and dead-stock reporting (issue #140).
 *
 * Deliberately its **own** module rather than part of `fields.ts`: that file is reachable from
 * `parse-text-query`, which the bridge imports, and the bridge is a Node service that must never
 * pull the app's React/UI modules into its graph (it runs under Node's strip-only loader — see
 * `bridge/README.md`). The label sources below live beside the item editor, so importing them
 * here keeps the UI-only dependency on the UI-only side of that line.
 */
import { CONDITION_LABELS, TRACKING_MODE_LABELS } from '@/features/inventory/components/inventory-ui';
import { DEAD_STOCK_MODE_OPTIONS } from '@/features/inventory/dead-stock-options';
import { enumValuesForField } from './fields';

/**
 * The label each enum member is already shown under elsewhere in the app, taken from that
 * concept's own SSOT rather than derived from the stored value.
 *
 * Deriving would be wrong twice over: the item editor calls `DISCRETE` "Bulk", and the
 * dead-stock setting calls `always` "Report" (the schema names the *decision*, the label names
 * what the user gets — see `dead-stock-options`). A search picker reading "Discrete" or
 * "Always" would be offering words that appear nowhere else in the UI.
 */
const ENUM_VALUE_LABELS: Readonly<Record<string, string>> = {
  ...CONDITION_LABELS,
  ...TRACKING_MODE_LABELS,
  ...Object.fromEntries(DEAD_STOCK_MODE_OPTIONS.map((option) => [option.value, option.label])),
};

/**
 * The picker options for an `enum` field: the value the column stores, under the label the rest
 * of the app uses for it. Empty for every other field kind.
 */
export function enumOptionsForField(field: string): { value: string; label: string }[] {
  return enumValuesForField(field).map((value) => ({
    value,
    label: ENUM_VALUE_LABELS[value] ?? value,
  }));
}
