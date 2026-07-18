/**
 * lab-flags — the registry of hidden testing flags (SSOT).
 *
 * The lab screen ({@link import('./LabScreen').LabScreen}, reachable only by typing its URL) is a
 * place to switch on behaviour that is normally decided for you — date-gated, device-gated, or
 * only reachable via an event you can't stage on demand (a deploy, a refused permission, a sync
 * race). Rather than each flag growing its own store field and its own row of UI, a flag is **one
 * entry in {@link LAB_FLAGS}**: the screen renders the list, and
 * {@link import('@/state/stores/useLabStore').useLabStore} stores the overrides by id.
 *
 * Flags are device-local, default-off, and read at the point of use. Every one of them changes how
 * the app *presents or judges* something — none writes to your data — so switching them all on and
 * then clearing browser storage returns the app to exactly how it ships. Anything genuinely
 * destructive belongs in the screen's separate **actions** section behind a confirmation, never
 * here as a toggle.
 */
import type { MessageKey } from '@/features/i18n/messages';

/** Stable id for one boolean lab flag. Persisted — do not rename an existing one. */
export type LabFlagId =
  | 'seasonal-dense'
  | 'seasonal-ignore-effect'
  | 'pwa-update-available'
  | 'pwa-update-breaking'
  | 'force-large-format'
  | 'no-camera'
  | 'storage-persistence-denied'
  | 'force-offline'
  | 'schema-too-new'
  | 'sync-lww-tie';

/** Grouping for the lab screen, so ten flags don't read as one undifferentiated list. */
export type LabFlagGroup = 'seasonal' | 'lifecycle' | 'device' | 'degraded';

export interface LabFlagDef {
  readonly id: LabFlagId;
  readonly group: LabFlagGroup;
  /**
   * The displayed text comes from the catalog via {@link labelKey} / {@link descriptionKey};
   * these English fields are the base reference, held byte-identical by a drift test.
   */
  readonly label: string;
  readonly description: string;
  readonly labelKey: MessageKey;
  readonly descriptionKey: MessageKey;
}

/** Group headings, in display order. */
export const LAB_FLAG_GROUPS: ReadonlyArray<{
  readonly id: LabFlagGroup;
  readonly labelKey: MessageKey;
}> = [
  { id: 'seasonal', labelKey: 'lab.group.seasonal' },
  { id: 'lifecycle', labelKey: 'lab.group.lifecycle' },
  { id: 'device', labelKey: 'lab.group.device' },
  { id: 'degraded', labelKey: 'lab.group.degraded' },
];

/** Every boolean lab flag, in display order. */
export const LAB_FLAGS: readonly LabFlagDef[] = [
  {
    id: 'seasonal-dense',
    group: 'seasonal',
    labelKey: 'lab.flag.seasonal-dense.label',
    descriptionKey: 'lab.flag.seasonal-dense.description',
    label: 'Dense seasonal garnish',
    description:
      'Spawn far more seasonal emoji than usual. The shipped garnish is deliberately sparse — a few pieces drifting past a minute — which makes it slow to eyeball. Turn this on to see the whole set at once.',
  },
  {
    id: 'seasonal-ignore-effect',
    group: 'seasonal',
    labelKey: 'lab.flag.seasonal-ignore-effect.label',
    descriptionKey: 'lab.flag.seasonal-ignore-effect.description',
    label: 'Seasonal garnish without a background effect',
    description:
      'Normally the garnish only rides an already-running rain or snow layer, so it never appears on its own. This runs it with the background effect set to None.',
  },
  {
    id: 'pwa-update-available',
    group: 'lifecycle',
    labelKey: 'lab.flag.pwa-update-available.label',
    descriptionKey: 'lab.flag.pwa-update-available.description',
    label: 'Pretend an update is waiting',
    description:
      'Shows the “a new version is ready” prompt without deploying anything. The incoming build is reported as sharing this build’s data format, so the prompt takes its reassuring path.',
  },
  {
    id: 'pwa-update-breaking',
    group: 'lifecycle',
    labelKey: 'lab.flag.pwa-update-breaking.label',
    descriptionKey: 'lab.flag.pwa-update-breaking.description',
    label: 'Pretend the waiting update changes the data format',
    description:
      'Reports the pretend update as using a newer data format, so the prompt shows its data-safety warning instead. Needs the flag above to be on.',
  },
  {
    id: 'force-large-format',
    group: 'device',
    labelKey: 'lab.flag.force-large-format.label',
    descriptionKey: 'lab.flag.force-large-format.description',
    label: 'Force the large-format layout',
    description:
      'The tablet layout needs both a large window and a touch screen, so a desktop can never show it. This forces it on regardless of the device.',
  },
  {
    id: 'no-camera',
    group: 'device',
    labelKey: 'lab.flag.no-camera.label',
    descriptionKey: 'lab.flag.no-camera.description',
    label: 'Pretend there is no camera',
    description:
      'Makes the barcode scanner behave as though the device has no usable camera, so its fallback and error copy can be checked on a machine that does have one.',
  },
  {
    id: 'storage-persistence-denied',
    group: 'degraded',
    labelKey: 'lab.flag.storage-persistence-denied.label',
    descriptionKey: 'lab.flag.storage-persistence-denied.description',
    label: 'Pretend persistent storage was refused',
    description:
      'Shows the “your data may be cleared by the browser” state even where the browser has already granted persistence.',
  },
  {
    id: 'force-offline',
    group: 'degraded',
    labelKey: 'lab.flag.force-offline.label',
    descriptionKey: 'lab.flag.force-offline.description',
    label: 'Pretend to be offline',
    description:
      'Reports the app as offline without touching your real connection, so offline banners and the queued-sync paths can be checked on demand.',
  },
  {
    id: 'schema-too-new',
    group: 'degraded',
    labelKey: 'lab.flag.schema-too-new.label',
    descriptionKey: 'lab.flag.schema-too-new.description',
    label: 'Pretend the local database is from a newer version',
    description:
      'Triggers the “this database was written by a newer Gubbins” screen, which normally only appears after opening an older build against a migrated database. Nothing on disk is actually changed.',
  },
  {
    id: 'sync-lww-tie',
    group: 'degraded',
    labelKey: 'lab.flag.sync-lww-tie.label',
    descriptionKey: 'lab.flag.sync-lww-tie.description',
    label: 'Force a sync timestamp tie',
    description:
      'Makes incoming rows arrive carrying exactly the local row’s timestamp, reproducing the tie that last-write-wins has to break. Useful when investigating devices that keep re-syncing the same rows.',
  },
] as const;

/** Look one up by id (unknown ids — e.g. a stale stored override — read as absent). */
export function getLabFlag(id: string): LabFlagDef | undefined {
  return LAB_FLAGS.find((flag) => flag.id === id);
}
