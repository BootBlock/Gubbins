import { cn } from '@/lib/utils';
import { useRovingRadioGroup } from '@/components/foundry';
import { LOW_STOCK_POLICY_OPTIONS, type LowStockPolicy } from '../low-stock-policy';

/**
 * The per-item low-stock alert policy picker — a compact, accessible segmented radiogroup
 * (WAI-ARIA `radiogroup`) shared by the Add-item dialog and the item editor so both offer
 * the same three choices: **Default** (follow the global blanket), **Custom** (own level)
 * and **Never** (a hard exemption). The group is a single tab stop (roving `tabindex`); once
 * focused, the arrow keys move *and* select and Home/End jump to the ends.
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
  const selectedIndex = Math.max(
    0,
    LOW_STOCK_POLICY_OPTIONS.findIndex((o) => o.value === value),
  );

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: LOW_STOCK_POLICY_OPTIONS.length,
    onSelect: (index) => onChange(LOW_STOCK_POLICY_OPTIONS[index]!.value),
  });

  return (
    <div
      role="radiogroup"
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': 'Low-stock alerts' })}
      className="inline-flex rounded-lg border border-border bg-secondary/40 p-0.5"
    >
      {LOW_STOCK_POLICY_OPTIONS.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(e) => onKeyDown(e, index)}
            data-testid={`low-stock-policy-${option.value}`}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              checked
                ? 'bg-card-elevated text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
