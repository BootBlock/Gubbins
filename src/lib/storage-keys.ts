/**
 * The single registry of every `gubbins:`-namespaced browser-storage key (issue #378).
 *
 * Three consumers need to know which keys exist, and they used to each keep their own list:
 * the Danger Zone's erase catalog (`features/danger-zone/erase-targets.ts`), the backup
 * settings allow-list (`features/backup/backup-settings.ts`), and the Safe-Mode hard reset
 * (`app/error/safe-mode-actions.ts`). The reset is a blanket `gubbins:` prefix sweep, so it
 * always caught everything — which is precisely what made the two *curated* lists drifting
 * behind it easy to miss: a new persisted store silently dropped out of erase and backup
 * while nothing appeared broken.
 *
 * So this module is the source of truth. Each entry declares, for one key:
 *
 *  - `storage` — which browser store it lives in. Only `'local'` keys are erasable/backupable;
 *    `'session'` and `'web-lock'` entries are listed so the registry is *complete* (and so the
 *    coverage test can account for them) rather than silently partial.
 *  - `eraseGroup` — the {@link LocalEraseGroupId} whose Danger-Zone target removes it, or
 *    `null` for a key deliberately kept out of the Danger Zone (each `null` carries a `note`
 *    saying why). A `null` is a *decision*; an omission is a bug.
 *  - `backupIncluded` — whether a portable backup file may carry it. Anything device-specific
 *    or secret stays `false`. The user-facing settings *groups* (`features/backup/
 *    settings-groups.ts`, issue #175) remain the authority for what a backup actually carries,
 *    since they also split the preferences blob by field; this flag records the same fact
 *    per key and the guard test asserts the two agree.
 *
 * `storage-keys.test.ts` scans the source tree for `'gubbins:…'` literals and fails when one
 * is missing here, so adding a store without registering it breaks the build rather than
 * quietly falling out of both curated lists.
 */

/**
 * The erase targets that own local keys. A subset of `EraseTargetId`: `erase-targets.ts` reads
 * these through a helper whose parameter intersects this union with its own target ids, so a
 * group naming a target that doesn't exist fails to compile there, and a runtime test asserts
 * the matching target really does erase the keys filed under it.
 */
export type LocalEraseGroupId =
  | 'preferences'
  | 'dashboard-layout'
  | 'saved-searches'
  | 'dismissed-alerts'
  | 'cloud-signin'
  | 'sync-links'
  | 'enabled-features'
  | 'local-ui';

/** Where a namespaced key actually lives. */
export type StorageMedium = 'local' | 'session' | 'web-lock';

/** One registered key. */
export interface StorageKeyEntry {
  readonly key: string;
  /** Human-readable owner (the store or module that reads/writes it) — for maintainers. */
  readonly store: string;
  readonly storage: StorageMedium;
  /** The Danger-Zone target that erases it, or `null` when deliberately excluded. */
  readonly eraseGroup: LocalEraseGroupId | null;
  /** Whether a portable backup may carry this key. */
  readonly backupIncluded: boolean;
  /** Required whenever `eraseGroup` is `null` or `storage` isn't `'local'` — explains why. */
  readonly note?: string;
}

/**
 * The emoji picker's remembered panel size. Unlike every other entry this one is not a
 * Zustand `persist` name — `usePersistedSize` reads and writes `localStorage` directly — so
 * the key is defined *here* and imported by the picker, rather than at the call site where
 * no registry could see it.
 */
export const EMOJI_PICKER_SIZE_KEY = 'gubbins:emoji-picker-size';

/**
 * Records the app version that already auto-reloaded this tab to recover from a code chunk the
 * host no longer serves (see `stale-chunk-reload.ts`), so a failed recovery can't loop. Defined
 * here for the same reason as the key above — it is written directly rather than through a
 * Zustand `persist` name.
 */
export const STALE_CHUNK_RELOAD_KEY = 'gubbins:stale-chunk-reload';

/**
 * Records that the user chose to open the database in this tab even though the single-tab
 * guard could not arbitrate (see `db/tab-lock.ts`). Defined here for the same reason as the
 * two keys above — it is written directly rather than through a Zustand `persist` name.
 */
export const TAB_LOCK_OVERRIDE_KEY = 'gubbins:tab-lock-override';

/**
 * Every `gubbins:` key, in rough order of how user-visible it is. Keep this list exhaustive:
 * the coverage test compares it against the literals in `src/`.
 *
 * @internal Exported for unit tests only.
 */
export const STORAGE_KEYS = [
  // --- Preferences & layout (the only things a backup carries) ----------------------
  {
    key: 'gubbins:preferences',
    store: 'usePreferencesStore',
    storage: 'local',
    eraseGroup: 'preferences',
    backupIncluded: true,
  },
  {
    key: 'gubbins:layout',
    store: 'useLayoutStore',
    storage: 'local',
    eraseGroup: 'dashboard-layout',
    backupIncluded: true,
  },
  {
    key: 'gubbins:saved-searches',
    store: 'useSavedSearchesStore',
    storage: 'local',
    eraseGroup: 'saved-searches',
    backupIncluded: true,
  },
  {
    key: 'gubbins:modules',
    store: 'useModulesStore',
    storage: 'local',
    eraseGroup: 'enabled-features',
    backupIncluded: false,
    note: 'Per-device feature gating — a kiosk and a desktop deliberately differ, so it never travels in a backup.',
  },

  // --- Suppression records (things the user has already been told about) ------------
  {
    key: 'gubbins:dismissed-alerts',
    store: 'useDismissedAlertsStore',
    storage: 'local',
    eraseGroup: 'dismissed-alerts',
    backupIncluded: false,
  },
  {
    key: 'gubbins:notified-reminders',
    store: 'useNotifiedRemindersStore',
    storage: 'local',
    eraseGroup: 'dismissed-alerts',
    backupIncluded: false,
  },

  // --- Sign-in (identity — never backed up) -----------------------------------------
  {
    // Who is signed in on this device (issue #79). Device-local by design: signing in on one
    // device must not sign another in. Holds an id and a display name only — never a role or
    // its grants, which are re-read from the database, so this is not a permissions store.
    key: 'gubbins:session',
    store: 'useSessionStore',
    storage: 'local',
    eraseGroup: 'cloud-signin',
    backupIncluded: false,
  },
  {
    key: 'gubbins:auth',
    store: 'useAuthStore',
    storage: 'local',
    eraseGroup: 'cloud-signin',
    backupIncluded: false,
  },
  {
    key: 'gubbins:google-drive-token',
    store: 'sync/providers/google-oauth',
    storage: 'local',
    eraseGroup: 'cloud-signin',
    backupIncluded: false,
  },
  {
    key: 'gubbins:google-oauth-pending',
    store: 'sync/providers/google-oauth',
    storage: 'local',
    eraseGroup: 'cloud-signin',
    backupIncluded: false,
  },
  {
    key: 'gubbins:google-oauth-error',
    store: 'sync/providers/google-oauth',
    storage: 'local',
    eraseGroup: 'cloud-signin',
    backupIncluded: false,
  },
  {
    key: 'gubbins:sync-conflicts',
    store: 'sync/conflict-store',
    storage: 'local',
    eraseGroup: 'sync-links',
    backupIncluded: false,
  },

  // --- Local odds & ends ------------------------------------------------------------
  {
    key: 'gubbins:export',
    store: 'useExportStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: 'gubbins:pwa-update-snooze',
    store: 'usePwaUpdateSnoozeStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: 'gubbins:location-expansion',
    store: 'useLocationExpansionStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: 'gubbins:audit-session',
    store: 'useAuditSessionStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: 'gubbins:milestones',
    store: 'useMilestonesStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: EMOJI_PICKER_SIZE_KEY,
    store: 'foundry/emoji-picker (usePersistedSize)',
    storage: 'local',
    eraseGroup: 'local-ui',
    backupIncluded: false,
  },
  {
    key: 'gubbins:clock-skew',
    store: 'useClockSkewStore',
    storage: 'local',
    eraseGroup: 'local-ui',
    // Never backed up: it describes *this* device's clock error, so restoring it onto another
    // machine would apply a correction for a fault that device does not have.
    backupIncluded: false,
  },

  // --- Deliberately outside the Danger Zone -----------------------------------------
  {
    key: 'gubbins:device-id',
    store: 'lib/env/device-id',
    storage: 'local',
    eraseGroup: null,
    backupIncluded: false,
    note: "This device's stable identity. Clearing it would orphan every locally-linked attachment (their stored origin device would stop matching), so it survives every selective erase and only goes in a full reset.",
  },
  {
    key: 'gubbins:lab',
    store: 'useLabStore',
    storage: 'local',
    eraseGroup: null,
    backupIncluded: false,
    note: 'Hidden developer overrides. Listing them as an erasable target would advertise a surface that is deliberately undocumented; the full reset still clears them.',
  },
  {
    key: 'gubbins:backup-restored',
    store: 'features/backup/restore-backup',
    storage: 'session',
    eraseGroup: null,
    backupIncluded: false,
    note: 'sessionStorage, not localStorage — a one-shot post-reload notice that dies with the tab.',
  },
  {
    key: 'gubbins:stale-chunk-reload',
    store: 'lib/stale-chunk-reload',
    storage: 'session',
    eraseGroup: null,
    backupIncluded: false,
    note: 'sessionStorage, not localStorage — a one-shot "this tab already reloaded to recover" marker that dies with the tab.',
  },
  {
    key: TAB_LOCK_OVERRIDE_KEY,
    store: 'db/tab-lock',
    storage: 'session',
    eraseGroup: null,
    backupIncluded: false,
    note: 'sessionStorage, not localStorage — the single-tab guard fails closed, and this records the user overriding it for *this* tab. It must die with the tab, or one override would disarm the guard permanently.',
  },
  {
    key: 'gubbins:db-tab',
    store: 'db/tab-lock',
    storage: 'web-lock',
    eraseGroup: null,
    backupIncluded: false,
    note: 'A Web Locks name, not a stored value — nothing to erase or back up.',
  },
] as const satisfies readonly StorageKeyEntry[];

/**
 * Every registered key, for the coverage test and the hard-reset assertion.
 *
 * @internal Exported for unit tests only.
 */
export const ALL_STORAGE_KEYS: readonly string[] = STORAGE_KEYS.map((entry) => entry.key);

/** The `localStorage` keys a given Danger-Zone target erases, in registry order. */
export function eraseGroupKeys(group: LocalEraseGroupId): readonly string[] {
  return STORAGE_KEYS.filter((entry) => entry.storage === 'local' && entry.eraseGroup === group).map(
    (entry) => entry.key,
  );
}

/**
 * The `localStorage` keys a portable backup may carry, in registry order.
 *
 * @internal Exported for unit tests only.
 */
export function backupIncludedKeys(): readonly string[] {
  return STORAGE_KEYS.filter((entry) => entry.storage === 'local' && entry.backupIncluded).map(
    (entry) => entry.key,
  );
}
