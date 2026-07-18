import type { MessageKey } from '@/features/i18n';
import type { GroupingMode } from '@/state/stores/useLayoutStore';

/**
 * The inventory grid's **arrangement** axis (spec §3) — how items are grouped, kept
 * orthogonal to the Data/Visual density axis (how each item is drawn). This is the
 * single source of truth for the modes the "Group by" control offers and how each
 * reads in the UI; adding a future mode (by category, by tag, …) is a new entry here
 * plus a branch in {@link GroupedItemList}, nothing else.
 *
 * Kept a plain descriptor list (label + hint) rather than wiring components, so the
 * control stays a dumb, exhaustive renderer of whatever modes exist.
 */
export interface GroupModeDescriptor {
  readonly value: GroupingMode;
  /**
   * Trigger/menu label — self-describing so "No grouping" never reads as an empty state. The
   * *displayed* text comes from the catalog via {@link labelKey}; this English field is the base
   * reference, held byte-identical to `en.json` by the catalog-drift test.
   */
  readonly label: string;
  readonly labelKey: MessageKey;
  /**
   * One-line explanation, intended as the option's help/tooltip. Not surfaced by any control yet,
   * so it is deliberately *not* in the message catalog — it would be speculative translation of
   * text nobody can read. Give it a `hintKey` at the point something renders it.
   */
  readonly hint: string;
}

export const GROUP_MODES: readonly GroupModeDescriptor[] = [
  {
    value: 'none',
    label: 'No grouping',
    labelKey: 'inventory.groupBy.none',
    hint: 'A single flat list of every matching item.',
  },
  {
    value: 'location',
    label: 'By location',
    labelKey: 'inventory.groupBy.location',
    hint: 'Collapsible sections mirroring your location hierarchy — browse items area by area.',
  },
];
