/**
 * Settings **groups** — the user-facing partition of the exportable settings surface (issue #175).
 *
 * A backup's settings are not one indivisible lump: the user decides which parts travel out (on
 * create) and which parts land (on restore). This module is the single source of truth for that
 * partition, and it is **pure** — the `localStorage` IO stays in `backup-settings.ts`.
 *
 * Two kinds of group exist, because the settings surface itself has two shapes:
 *
 *  - a group that owns whole `localStorage` **keys** (the dashboard layout, saved searches), and
 *  - a group that owns named **fields inside** the `gubbins:preferences` blob (theme, units, …).
 *
 * Every persisted preference field belongs to exactly one group, or is listed in
 * {@link NON_PORTABLE_PREF_FIELDS} as deliberately unexportable. A drift test pins that, so a
 * preference added in a later build cannot silently fall out of the picker — and cannot silently
 * travel in a backup the user never agreed to send it in.
 */

// Type-only (erased at build), so the pure module stays free of an i18n runtime dependency.
import type { MessageKey } from '@/features/i18n';

/** A group's stable id — what a {@link SettingsGroupSelection} is keyed by, and what tests pin. */
export type SettingsGroupId =
  | 'appearance'
  | 'regional'
  | 'cards'
  | 'dashboard'
  | 'alerts'
  | 'shortcuts'
  | 'scanning'
  | 'catalogue'
  | 'reports'
  | 'savedSearches'
  | 'device';

/** The `localStorage` key holding the main preferences blob (the field-owning groups' source). */
export const PREFERENCES_KEY = 'gubbins:preferences';

export interface SettingsGroup {
  readonly id: SettingsGroupId;
  /** i18n key for the group's title in the picker (typed, so a mistyped key fails the build). */
  readonly labelKey: MessageKey;
  /** i18n key for the one-line description under the title. */
  readonly hintKey: MessageKey;
  /**
   * Whole `localStorage` keys this group owns (present ⇒ the key travels only when the group is
   * chosen). Never includes {@link PREFERENCES_KEY} — that blob is split by field instead.
   */
  readonly storageKeys?: readonly string[];
  /** Fields inside the preferences blob this group owns. */
  readonly prefFields?: readonly string[];
  /**
   * Whether the group is chosen by default when creating a backup. `device` is off: a bridge
   * address, kiosk mode or a dismissed prompt describes *this* machine, so carrying it to another
   * one is more often wrong than right (the user can still opt in).
   */
  readonly defaultOn: boolean;
}

/**
 * The groups, in the order the picker shows them — broadly "most likely to want" first, with the
 * device-specific group last.
 *
 * @internal Exported for unit tests only.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'appearance',
    labelKey: 'backup.settingsGroup.appearance.label',
    hintKey: 'backup.settingsGroup.appearance.hint',
    defaultOn: true,
    prefFields: [
      'mode',
      'accent',
      'oledDark',
      'highContrast',
      'fullWidth',
      'animationLevel',
      'backgroundEffect',
      'holographicCards',
      'gamifyCards',
      'customAccentEnabled',
      'customAccentHue',
      'brandTagline',
      'surfaceStyle',
      'categoryWatermarks',
    ],
  },
  {
    id: 'regional',
    labelKey: 'backup.settingsGroup.regional.label',
    hintKey: 'backup.settingsGroup.regional.hint',
    defaultOn: true,
    prefFields: ['baseCurrency', 'locale', 'weightUnit', 'dimensionUnit'],
  },
  {
    id: 'cards',
    labelKey: 'backup.settingsGroup.cards.label',
    hintKey: 'backup.settingsGroup.cards.hint',
    defaultOn: true,
    prefFields: [
      'visualCardMetric',
      'visualCardMetricFallback',
      'cardClickAction',
      'cardBadgeContent',
      'cardBadgeFallback',
      'cardFields',
      'paginateLists',
      'defaultPageSize',
    ],
  },
  {
    id: 'dashboard',
    labelKey: 'backup.settingsGroup.dashboard.label',
    hintKey: 'backup.settingsGroup.dashboard.hint',
    defaultOn: true,
    storageKeys: ['gubbins:layout'],
    prefFields: [
      'navCountMetrics',
      'dashboardCommandPalette',
      'dashboardQuickActions',
      'dashboardGettingStarted',
      'hideHealthyDashboardCards',
    ],
  },
  {
    id: 'alerts',
    labelKey: 'backup.settingsGroup.alerts.label',
    hintKey: 'backup.settingsGroup.alerts.hint',
    defaultOn: true,
    prefFields: [
      'expirySoonWindowDays',
      'lowStockQtyThreshold',
      'lowStockGaugePercent',
      'deadStockDays',
      'budgetWarnPercent',
      'remindersEnabled',
      'reminderKinds',
    ],
  },
  {
    id: 'shortcuts',
    labelKey: 'backup.settingsGroup.shortcuts.label',
    hintKey: 'backup.settingsGroup.shortcuts.hint',
    defaultOn: true,
    prefFields: ['hotkeysEnabled', 'hotkeyBindings'],
  },
  {
    id: 'scanning',
    labelKey: 'backup.settingsGroup.scanning.label',
    hintKey: 'backup.settingsGroup.scanning.hint',
    defaultOn: true,
    prefFields: [
      'scannerSymbology',
      'scannerBeep',
      'scannerHaptics',
      'labelTemplate',
      'labelBaseUrl',
      'attachmentMode',
      'scrapeNotifications',
      'allowOnlineProductLookup',
      'ocrEnabled',
      'ocrModel',
    ],
  },
  {
    id: 'catalogue',
    labelKey: 'backup.settingsGroup.catalogue.label',
    hintKey: 'backup.settingsGroup.catalogue.hint',
    defaultOn: true,
    prefFields: [
      'catalogueTitle',
      'catalogueOrgName',
      'catalogueOrgDetails',
      'catalogueFooter',
      'catalogueLogo',
      'catalogueShowGeneratedDate',
      'cataloguePageNumbers',
      'catalogueRunningHeader',
      'cataloguePaperPreview',
    ],
  },
  {
    id: 'reports',
    labelKey: 'backup.settingsGroup.reports.label',
    hintKey: 'backup.settingsGroup.reports.hint',
    defaultOn: true,
    prefFields: [
      'reportsAnalyticsWindow',
      'reportsMovementWindow',
      'reportsSpendWindow',
      'reportsSalesWindow',
      'pruneWindowMonths',
      'downgradeWindowMonths',
    ],
  },
  {
    id: 'savedSearches',
    labelKey: 'backup.settingsGroup.savedSearches.label',
    hintKey: 'backup.settingsGroup.savedSearches.hint',
    defaultOn: true,
    storageKeys: ['gubbins:saved-searches'],
  },
  {
    id: 'device',
    labelKey: 'backup.settingsGroup.device.label',
    hintKey: 'backup.settingsGroup.device.hint',
    defaultOn: false,
    prefFields: [
      'bridgeUrl',
      'scaleEntityId',
      'kioskMode',
      'lastArchivedAt',
      'archiveNudgeSnoozedUntil',
      'backupNudgeDismissed',
      'wipBannerDismissed',
    ],
  },
];

/**
 * Preference fields that never travel in a backup at all, whatever the user picks. Currently just
 * the bridge **access token** — a shared backup must not leak it (the non-secret bridge URL is in
 * the `device` group instead). Listed here so the drift test can tell "deliberately excluded"
 * apart from "someone forgot to group it".
 */
export const NON_PORTABLE_PREF_FIELDS: readonly string[] = ['bridgeToken'];

/** Which groups the user chose, keyed by id. */
export type SettingsGroupSelection = Readonly<Record<SettingsGroupId, boolean>>;

/** Every group id, in picker order. */
export const SETTINGS_GROUP_IDS: readonly SettingsGroupId[] = SETTINGS_GROUPS.map((g) => g.id);

/** The shipped default selection — everything except the device-specific group. */
export const DEFAULT_SETTINGS_GROUPS: SettingsGroupSelection = Object.fromEntries(
  SETTINGS_GROUPS.map((group) => [group.id, group.defaultOn]),
) as SettingsGroupSelection;

/** A selection with every group on / off — for the picker's "All"/"None" shortcuts and tests. */
export function allSettingsGroups(value: boolean): SettingsGroupSelection {
  return Object.fromEntries(SETTINGS_GROUP_IDS.map((id) => [id, value])) as SettingsGroupSelection;
}

/** Look a group up by id (undefined for an unknown id from a hand-edited file). */
export function settingsGroup(id: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((group) => group.id === id);
}

/** The whole-key groups' keys, flattened (i.e. every exportable key that is not the prefs blob). */
export const GROUPED_STORAGE_KEYS: readonly string[] = SETTINGS_GROUPS.flatMap(
  (group) => group.storageKeys ?? [],
);

/** Map of preference field → the group that owns it, built once from {@link SETTINGS_GROUPS}. */
const FIELD_OWNER: ReadonlyMap<string, SettingsGroupId> = new Map(
  SETTINGS_GROUPS.flatMap((group) => (group.prefFields ?? []).map((field) => [field, group.id] as const)),
);

/**
 * The group owning a preference field, or undefined when it is ungrouped/non-portable.
 *
 * @internal Exported for unit tests only.
 */
export function ownerOfPrefField(field: string): SettingsGroupId | undefined {
  return FIELD_OWNER.get(field);
}

/** Read the `state` object out of a persisted Zustand blob; null when it isn't one. */
function parseStoreBlob(
  raw: string,
): { state: Record<string, unknown>; envelope: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = parsed?.state;
    if (!parsed || typeof parsed !== 'object' || !state || typeof state !== 'object') return null;
    return { state: state as Record<string, unknown>, envelope: parsed };
  } catch {
    return null;
  }
}

/**
 * Narrow an already-sanitised settings record to the chosen groups. **Pure.**
 *
 * Whole-key groups drop their keys when unchosen; the preferences blob is rewritten to carry only
 * the fields whose group is chosen, and is dropped entirely when that leaves it empty. A field
 * with no owning group (a preference added by a newer build, or a hand-edited key) is dropped —
 * the picker could not have offered it, so the user cannot have agreed to send it.
 */
export function filterSettingsByGroups(
  record: Readonly<Record<string, string>>,
  selection: SettingsGroupSelection,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const group of SETTINGS_GROUPS) {
    if (!selection[group.id]) continue;
    for (const key of group.storageKeys ?? []) {
      const value = record[key];
      if (typeof value === 'string') out[key] = value;
    }
  }

  const prefsRaw = record[PREFERENCES_KEY];
  if (typeof prefsRaw === 'string') {
    const blob = parseStoreBlob(prefsRaw);
    if (blob) {
      const kept: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(blob.state)) {
        const owner = ownerOfPrefField(field);
        if (owner && selection[owner]) kept[field] = value;
      }
      if (Object.keys(kept).length > 0) {
        out[PREFERENCES_KEY] = JSON.stringify({ ...blob.envelope, state: kept });
      }
    }
  }

  return out;
}

/**
 * Which groups a settings record actually carries content for — what the restore picker offers,
 * so a backup made without (say) saved searches never shows a tick-box that would do nothing.
 * **Pure.**
 */
export function settingsGroupsPresent(record: Readonly<Record<string, string>>): SettingsGroupId[] {
  const present = new Set<SettingsGroupId>();

  for (const group of SETTINGS_GROUPS) {
    for (const key of group.storageKeys ?? []) {
      if (typeof record[key] === 'string') present.add(group.id);
    }
  }

  const prefsRaw = record[PREFERENCES_KEY];
  if (typeof prefsRaw === 'string') {
    const blob = parseStoreBlob(prefsRaw);
    for (const field of Object.keys(blob?.state ?? {})) {
      const owner = ownerOfPrefField(field);
      if (owner) present.add(owner);
    }
  }

  // Return in picker order rather than insertion order, so the UI is stable.
  return SETTINGS_GROUP_IDS.filter((id) => present.has(id));
}

/**
 * Merge a restored preferences blob **over** the live one rather than replacing it. Restoring a
 * subset of groups must not reset the rest: a wholesale write of a group-filtered blob would leave
 * every unchosen field absent, and the store would re-hydrate those to their factory defaults.
 *
 * The incoming envelope (notably Zustand's persist `version`) wins, exactly as it did when the
 * whole blob was written verbatim, so the store's own migrations still run over the result.
 * Returns the merged JSON string, or the incoming string unchanged when either side isn't a
 * readable store blob.
 */
export function mergePreferencesBlob(incoming: string, existing: string | null): string {
  const next = parseStoreBlob(incoming);
  const current = existing === null ? null : parseStoreBlob(existing);
  if (!next || !current) return incoming;
  return JSON.stringify({ ...next.envelope, state: { ...current.state, ...next.state } });
}
