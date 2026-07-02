import { Select, type SelectOption } from '@/components/foundry';

/**
 * One choice in the {@link LocationSelect} list. Structurally identical to the Foundry
 * {@link SelectOption} (kept as its own name for the many call sites that build location
 * lists); `value` `''` is the synthetic "top level" entry, `colorClass` is the location's
 * swatch token, and `kind: 'action'` marks a "＋ New location…" command row.
 */
export type LocationOption = SelectOption;

/**
 * The location **Parent/home** picker — a thin adapter over the Foundry {@link Select}
 * combobox that names itself from an existing visible label via `labelledBy` (a
 * `role="combobox"` element isn't a labelable control, so a wrapping `<label>` can't name
 * it). All of the accessible listbox behaviour — keyboard driving, the per-row colour
 * swatch, the right-aligned item count and the pinned "＋ New location…" action row — now
 * lives in the shared primitive, so every combobox in the app renders these rows the same
 * way.
 */
export function LocationSelect({
  value,
  onChange,
  options,
  labelledBy,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly LocationOption[];
  /** Id of the visible label element naming this control. */
  labelledBy: string;
  id?: string;
}) {
  return <Select id={id} value={value} onChange={onChange} options={options} aria-labelledby={labelledBy} />;
}
