/**
 * The user-facing labels for the three dead-stock reporting modes (issue #92), shared by
 * the item editor and the location dialog so both offer identical wording. Split out from
 * the components for the same reason `low-stock-policy.ts` is: one source of truth, and no
 * React import needed to reuse it.
 *
 * The stored values are deliberately `always` / `never` rather than "report"/"ignore" — the
 * schema names the *decision* (this level always/never decides), while the labels name what
 * the user gets. Keeping the mapping here stops the two vocabularies drifting apart.
 */
import type { SegmentedOption } from '@/components/foundry';
import type { DeadStockMode } from '@/db/repositories/constants';

export const DEAD_STOCK_MODE_OPTIONS: readonly SegmentedOption<DeadStockMode>[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'always', label: 'Report' },
  { value: 'never', label: 'Ignore' },
];
