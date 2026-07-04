import { Select } from '@/components/foundry';
import { useLayoutStore } from '@/state/stores/useLayoutStore';
import { GROUP_MODES } from '../grouping';

/**
 * The inventory "Group by" arrangement chooser (spec §3) — the counterpart to the
 * Data/Visual {@link LayoutToggle} on the *arrangement* axis. A Foundry {@link Select}
 * (not a segmented toggle) precisely because this axis is designed to grow: the option
 * list is driven straight off the {@link GROUP_MODES} SSOT, so a future mode (by
 * category, by tag, …) appears here for free with no layout re-work.
 *
 * The trigger shows the active mode's own words ("No grouping" / "By location"), so it
 * reads as a self-describing menu rather than needing a separate visible label.
 */
export function GroupByControl() {
  const grouping = useLayoutStore((s) => s.grouping);
  const setGrouping = useLayoutStore((s) => s.setGrouping);

  return (
    <Select
      value={grouping}
      onChange={(value) => setGrouping(value as (typeof GROUP_MODES)[number]['value'])}
      options={GROUP_MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
      aria-label="Group items by"
      data-testid="group-by-control"
      className="w-44"
    />
  );
}
