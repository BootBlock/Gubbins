/**
 * Per-item low-stock alert *policy* — the pure mapping between the three user-facing
 * choices and the stored `reorder_point` / `reorder_gauge_percent` value (spec §4 low-stock
 * alerts). Kept side-effect-free so both the Add-item dialog and the item editor share one
 * source of truth and the mapping is unit-testable in isolation.
 *
 * Low-stock alerts are opt-in, and an item's stored floor encodes three distinct intents:
 *
 * - `'default'` — no per-item override (**null**). The item follows the global blanket in
 *   Settings: watched at that level if it's on, silent if it's off (the friction-free
 *   default for a brand-new item).
 * - `'custom'` — the item carries its **own positive floor** (> 0); it is always watched at
 *   that level, whatever the global default.
 * - `'never'` — an explicit **0**, a hard exemption: the item is never flagged, even when a
 *   global blanket is switched on. The counterpart to `'custom'` for "leave me alone".
 *
 * `null` and `0` differ only when a global blanket is set — `null` opts into it, `0` opts
 * out — but the distinction is always meaningful because the global blanket can be raised
 * later.
 */
export type LowStockPolicy = 'default' | 'custom' | 'never';

/** Which policy a stored floor value represents (null → default, 0 → never, +ve → custom). */
export function policyFromValue(value: number | null | undefined): LowStockPolicy {
  if (value == null) return 'default';
  if (value <= 0) return 'never';
  return 'custom';
}

/**
 * The floor value to persist for a chosen policy:
 * - `default` → `null` (clear the override).
 * - `never` → `0` (hard exemption).
 * - `custom` → the entered `customValue` verbatim (may be `null` if the field is blank —
 *   the caller decides whether to seed a suggestion before saving).
 */
export function valueForPolicy(policy: LowStockPolicy, customValue: number | null): number | null {
  if (policy === 'default') return null;
  if (policy === 'never') return 0;
  return customValue;
}

/** The three choices, in display order, with short segmented-control labels. */
export const LOW_STOCK_POLICY_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'custom', label: 'Custom' },
  { value: 'never', label: 'Never' },
] as const satisfies readonly { value: LowStockPolicy; label: string }[];
