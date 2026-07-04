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
  /** Trigger/menu label — self-describing so "No grouping" never reads as an empty state. */
  readonly label: string;
  /** One-line explanation surfaced as the option's help/tooltip. */
  readonly hint: string;
}

export const GROUP_MODES: readonly GroupModeDescriptor[] = [
  {
    value: 'none',
    label: 'No grouping',
    hint: 'A single flat list of every matching item.',
  },
  {
    value: 'location',
    label: 'By location',
    hint: 'Collapsible sections mirroring your location hierarchy — browse items area by area.',
  },
];
