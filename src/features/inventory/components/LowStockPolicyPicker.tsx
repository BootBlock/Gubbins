import { SegmentedRadioGroup } from '@/components/foundry';
import { LOW_STOCK_POLICY_OPTIONS, type LowStockPolicy } from '../low-stock-policy';

/**
 * The per-item low-stock alert policy picker — a thin binding of the Foundry
 * {@link SegmentedRadioGroup} to the three low-stock choices, shared by the Add-item dialog
 * and the item editor so both offer the same options: **Default** (follow the global
 * blanket), **Custom** (own level) and **Never** (a hard exemption).
 *
 * Presentation only — the caller owns the value, reveals the custom-level input when the
 * value is `'custom'`, and persists {@link valueForPolicy}.
 */
export function LowStockPolicyPicker({
  value,
  onChange,
  labelledBy,
}: {
  value: LowStockPolicy;
  onChange: (policy: LowStockPolicy) => void;
  /** Id of the visible label naming this group; falls back to an `aria-label` when absent. */
  labelledBy?: string;
}) {
  return (
    <SegmentedRadioGroup
      options={LOW_STOCK_POLICY_OPTIONS}
      value={value}
      onChange={onChange}
      labelledBy={labelledBy}
      label="Low-stock alerts"
      testIdPrefix="low-stock-policy"
    />
  );
}
