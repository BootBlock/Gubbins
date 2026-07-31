/**
 * ReminderSettings — the Settings controls for local reminder notifications (G3).
 *
 * A master opt-in plus a per-lane switch, rendered as {@link SettingRow}s inside the Settings
 * "Notifications" section. Enabling reminders requests the browser's notification permission
 * through the injectable {@link ReminderApi} seam (a user gesture — the Select click); if the
 * permission is denied or the platform can't show notifications, the control degrades to an
 * explanatory note and stays off (§3, §6.1 graceful degradation).
 *
 * Local only — never Web Push. See {@link ./reminders} for the pure "what fires now" seam.
 */
import { useMemo, useState } from 'react';
import { Select } from '@/components/foundry';
import { SettingRow } from '@/features/settings/SettingsSection';
import { useFeature } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { AlertKind } from './alerts';
import { REMINDER_KINDS, REMINDER_KIND_LABELS } from './reminders';
import { browserReminderApi, type ReminderApi } from './reminder-api';
import { useNotifiedRemindersStore } from './useNotifiedRemindersStore';
import { useReminderWakeStore } from './useReminderWakeStore';

/** On/off pair (On listed first), matching the other boolean-preference selects. */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** The capabilities that gate a notify-able lane. Low stock is core inventory and never gated. */
type GatedLaneFeature = 'perishables' | 'maintenance' | 'warranty' | 'custom-fields';

/** Which capability each notify-able lane belongs to, so a hidden module hides its switch. */
const KIND_FEATURE: Partial<Record<AlertKind, GatedLaneFeature>> = {
  expiry: 'perishables',
  'maintenance-due': 'maintenance',
  'warranty-due': 'warranty',
  'field-due': 'custom-fields',
};

/**
 * Renders the reminder-notification rows. Pass a fake `apiOverride` in tests; production uses
 * the browser seam. Designed to sit inside a Settings `divide-y` section alongside other rows.
 */
export function ReminderSettings({ apiOverride }: { readonly apiOverride?: ReminderApi } = {}) {
  const t = useT();
  const api = useMemo(() => apiOverride ?? browserReminderApi(), [apiOverride]);
  const [permission, setPermission] = useState(() => api.permission());
  const wakeStatus = useReminderWakeStore((s) => s.status);

  const enabled = usePreferencesStore((s) => s.remindersEnabled);
  const kinds = usePreferencesStore((s) => s.reminderKinds);
  const setRemindersEnabled = usePreferencesStore((s) => s.setRemindersEnabled);
  const setReminderKind = usePreferencesStore((s) => s.setReminderKind);
  const clearNotified = useNotifiedRemindersStore((s) => s.clear);

  const perishablesOn = useFeature('perishables');
  const maintenanceOn = useFeature('maintenance');
  const warrantyOn = useFeature('warranty');
  const customFieldsOn = useFeature('custom-fields');
  const featureOn: Record<GatedLaneFeature, boolean> = {
    perishables: perishablesOn,
    maintenance: maintenanceOn,
    warranty: warrantyOn,
    'custom-fields': customFieldsOn,
  };

  const handleMasterChange = async (value: string) => {
    if (value === 'off') {
      setRemindersEnabled(false);
      // Forget what we've already notified, so re-enabling later starts fresh.
      clearNotified();
      return;
    }
    // Turning on: ensure permission. Requesting from this click is a valid user gesture.
    let perm = api.permission();
    if (perm === 'default') perm = await api.requestPermission();
    setPermission(perm);
    setRemindersEnabled(perm === 'granted');
  };

  // The master control: a note where the platform can't show notifications, otherwise the toggle.
  const masterControl = !api.supported ? (
    <span className="text-sm text-muted-foreground" data-testid="reminders-unsupported">
      Not available on this device
    </span>
  ) : (
    <Select
      aria-label="Reminder notifications"
      data-testid="setting-reminders-enabled"
      className="h-9 w-40"
      value={enabled ? 'on' : 'off'}
      onChange={(value) => void handleMasterChange(value)}
      options={ON_OFF_OPTIONS}
    />
  );

  const showPerKind = api.supported && enabled && permission === 'granted';

  return (
    <>
      <SettingRow
        label="Reminders"
        description={t('settings.reminders.description')}
        hintSize="md"
        hint={
          'Surfaces the same alerts you see in the **Alert centre** as **device notifications**, so an ' +
          'installed Gubbins can remind you even when it isn’t open.\n\n' +
          '- You’ll be asked for the browser’s **notification permission** when you turn this on.\n' +
          '- It works **entirely on your device** — nothing is sent to any server (no web push).\n' +
          '- Where notifications aren’t available or are blocked (e.g. some browsers), reminders stay ' +
          'in-app only.\n\n' +
          'Choose which kinds notify below.'
        }
      >
        {masterControl}
      </SettingRow>

      {permission === 'denied' && api.supported ? (
        <SettingRow
          label="Notifications blocked"
          description="Your browser is blocking notifications for this site. Allow them in the browser’s site settings, then turn reminders on."
        >
          <span className="text-sm text-warning" data-testid="reminders-denied-note">
            Blocked
          </span>
        </SettingRow>
      ) : null}

      {/* The background wake-up is best-effort, but a browser that refuses it leaves reminders
          arriving only while Gubbins is open — say so rather than leaving the toggle reading a
          plain "On". Nothing is shown where one was never wanted or the platform lacks it. */}
      {showPerKind && wakeStatus === 'unavailable' ? (
        <SettingRow
          label={t('settings.reminders.backgroundWake.label')}
          description={t('settings.reminders.backgroundWake.description')}
        >
          <span className="text-sm text-warning" data-testid="reminders-background-wake-note">
            {t('settings.reminders.backgroundWake.status')}
          </span>
        </SettingRow>
      ) : null}

      {showPerKind
        ? REMINDER_KINDS.map((kind) => {
            const feature = KIND_FEATURE[kind];
            if (feature && !featureOn[feature]) return null;
            const label = REMINDER_KIND_LABELS[kind];
            return (
              <SettingRow
                key={kind}
                label={label}
                description={`Notify when a ${label.toLowerCase()} alert is due.`}
              >
                <Select
                  aria-label={`${label} reminders`}
                  data-testid={`setting-reminder-${kind}`}
                  className="h-9 w-40"
                  value={kinds[kind] ? 'on' : 'off'}
                  onChange={(value) => setReminderKind(kind, value === 'on')}
                  options={ON_OFF_OPTIONS}
                />
              </SettingRow>
            );
          })
        : null}
    </>
  );
}
