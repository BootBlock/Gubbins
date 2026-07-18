/**
 * lab-flags — the registry of hidden testing flags (SSOT).
 *
 * The lab screen ({@link import('./LabScreen').LabScreen}, reachable only by typing its URL) is a
 * place to switch behaviour on that is normally decided for you — most of it date-gated or
 * otherwise awkward to reach on demand. Rather than each flag growing its own store field and its
 * own row of UI, a flag is **one entry in {@link LAB_FLAGS}**: the screen renders the list, and
 * {@link import('@/state/stores/useLabStore').useLabStore} stores the overrides by id.
 *
 * Flags are device-local, default-off, and read at the point of use — nothing here changes stored
 * data, and clearing the browser's storage returns the app to its shipped behaviour.
 */
import type { MessageKey } from '@/features/i18n/messages';

/** Stable id for one boolean lab flag. Persisted — do not rename an existing one. */
export type LabFlagId = 'seasonal-dense' | 'seasonal-ignore-effect';

export interface LabFlagDef {
  readonly id: LabFlagId;
  /**
   * The displayed text comes from the catalog via {@link labelKey} / {@link descriptionKey};
   * these English fields are the base reference, held byte-identical by a drift test.
   */
  readonly label: string;
  readonly description: string;
  readonly labelKey: MessageKey;
  readonly descriptionKey: MessageKey;
}

/** Every boolean lab flag, in display order. */
export const LAB_FLAGS: readonly LabFlagDef[] = [
  {
    id: 'seasonal-dense',
    labelKey: 'lab.flag.seasonal-dense.label',
    descriptionKey: 'lab.flag.seasonal-dense.description',
    label: 'Dense seasonal garnish',
    description:
      'Spawn far more seasonal emoji than usual. The shipped garnish is deliberately sparse — a few pieces drifting past a minute — which makes it slow to eyeball. Turn this on to see the whole set at once.',
  },
  {
    id: 'seasonal-ignore-effect',
    labelKey: 'lab.flag.seasonal-ignore-effect.label',
    descriptionKey: 'lab.flag.seasonal-ignore-effect.description',
    label: 'Seasonal garnish without a background effect',
    description:
      'Normally the garnish only rides an already-running rain or snow layer, so it never appears on its own. This runs it with the background effect set to None.',
  },
] as const;
