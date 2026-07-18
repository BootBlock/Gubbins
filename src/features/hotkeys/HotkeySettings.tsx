/**
 * The Settings dialog's **Hotkeys** tab (issue #32) — the master switch plus one rebindable
 * row per action.
 *
 * Rebinding is *recorded*, not typed: pressing "Change" puts the row into a capture state where
 * the very next chord becomes the binding. That is the only honest way to bind a key — asking
 * someone to type `Ctrl+Shift+I` into a text box means parsing prose, and gets the modifier
 * spelling wrong on every platform but the author's. Capture runs on `keydown` in the **capture
 * phase** so the chord can't be swallowed by the dialog's own handlers on its way past (the
 * `use-search-escape.ts` precedent), and Escape cancels rather than binding, since a key you
 * cannot get out of the recorder with is a trap.
 *
 * Actions whose module is switched off are hidden — rebinding a shortcut to a screen that no
 * longer exists in this install would be a dead control, exactly as the nav hides the row.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, LiveRegion, Select } from '@/components/foundry';
import { CloseIcon, HotkeyIcon, ResetIcon, WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { SettingsSection, SettingRow } from '@/features/settings/SettingsSection';
import {
  HOTKEY_ACTIONS,
  bindingFromEvent,
  displayBinding,
  findHotkeyConflicts,
  isMacKeyboard,
  normaliseHotkeyBindings,
  rejectBinding,
  type HotkeyAction,
  type HotkeyActionId,
} from './hotkeys';

/** On/off pair, mirroring the Settings dialog's own boolean control convention. */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** Spell modifiers the macOS way (`⌘⇧K`) rather than `Ctrl+Shift+K`; settled once at load. */
const IS_MAC = isMacKeyboard();

export function HotkeySettings() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const setEnabled = usePreferencesStore((s) => s.setHotkeysEnabled);
  const stored = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const setBinding = usePreferencesStore((s) => s.setHotkeyBinding);
  const resetBindings = usePreferencesStore((s) => s.resetHotkeyBindings);
  const enabledFeatures = useEnabledFeatures();

  // Which row is currently listening for a chord, or null while idle.
  const [recording, setRecording] = useState<HotkeyActionId | null>(null);
  // The outcome of the last capture — announced, and shown beneath the row that caused it.
  const [notice, setNotice] = useState<string | null>(null);

  // Derived once per change rather than per render — this also keeps `bindings` stable, so a
  // row's capture listener isn't torn down and re-added on every keystroke in the recorder.
  const bindings = useMemo(() => normaliseHotkeyBindings(stored), [stored]);
  const conflicts = useMemo(() => findHotkeyConflicts(bindings), [bindings]);
  // An action is listed only when it could actually fire: its module is on, and any extra
  // preference it depends on is too. Otherwise the tab would offer a live-looking control for a
  // hidden capability — the orphaned setting the rest of the Settings dialog is careful to avoid.
  const visible = useMemo(
    () =>
      HOTKEY_ACTIONS.filter(
        (a) =>
          (a.feature === undefined || enabledFeatures.has(a.feature)) &&
          (a.requiresPref !== 'dashboardCommandPalette' || paletteEnabled),
      ),
    [enabledFeatures, paletteEnabled],
  );

  return (
    <>
      <SettingsSection icon={<HotkeyIcon />} title={t('hotkeys.section')}>
        <SettingRow
          label={t('hotkeys.enabled.label')}
          description={t('hotkeys.enabled.description')}
          hint={t('hotkeys.enabled.hint')}
        >
          <Select
            className="h-9 w-40"
            aria-label={t('hotkeys.enabled.label')}
            data-testid="setting-hotkeys-enabled"
            value={enabled ? 'on' : 'off'}
            onChange={(v) => setEnabled(v === 'on')}
            options={[...ON_OFF_OPTIONS]}
          />
        </SettingRow>

        {visible.map((action) => (
          <HotkeyRow
            key={action.id}
            action={action}
            binding={bindings[action.id]}
            conflicting={conflicts.has(action.id)}
            disabled={!enabled}
            recording={recording === action.id}
            onRecord={() => {
              setNotice(null);
              setRecording(action.id);
            }}
            onCancel={() => setRecording(null)}
            onCapture={(candidate) => {
              setRecording(null);
              const rejection = rejectBinding(candidate);
              if (rejection !== null) {
                setNotice(
                  t(rejection === 'reserved' ? 'hotkeys.rejected.reserved' : 'hotkeys.rejected.invalid', {
                    vars: { binding: displayBinding(candidate, IS_MAC) },
                  }),
                );
                return;
              }
              setBinding(action.id, candidate);
              setNotice(
                t('hotkeys.assigned', {
                  vars: { binding: displayBinding(candidate, IS_MAC), action: t(action.messageKey) },
                }),
              );
            }}
            onClear={() => {
              setBinding(action.id, '');
              setNotice(t('hotkeys.cleared', { vars: { action: t(action.messageKey) } }));
            }}
          />
        ))}

        <SettingRow label={t('hotkeys.reset.label')} description={t('hotkeys.reset.description')} noWrap>
          <Button
            variant="outline"
            data-testid="setting-hotkeys-reset"
            onClick={() => {
              resetBindings();
              setRecording(null);
              setNotice(t('hotkeys.reset.done'));
            }}
          >
            <ResetIcon /> {t('hotkeys.reset.action')}
          </Button>
        </SettingRow>
      </SettingsSection>

      {/* One shared announcement channel for every rebind outcome in the tab. It sits outside
        the section rather than among its rows: SettingsSection divides its children with
        `divide-y`, and an always-mounted live region would draw a stray rule below the last
        row whenever there is nothing to announce. */}
      <LiveRegion className="mt-2 px-5" data-testid="setting-hotkeys-notice">
        {notice ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
      </LiveRegion>
    </>
  );
}

function HotkeyRow({
  action,
  binding,
  conflicting,
  disabled,
  recording,
  onRecord,
  onCancel,
  onCapture,
  onClear,
}: {
  readonly action: HotkeyAction;
  readonly binding: string;
  readonly conflicting: boolean;
  readonly disabled: boolean;
  readonly recording: boolean;
  readonly onRecord: () => void;
  readonly onCancel: () => void;
  readonly onCapture: (binding: string) => void;
  readonly onClear: () => void;
}) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // While recording, the next chord anywhere in the document becomes the binding. Capture-phase
  // so the dialog's own key handling (Escape to close, the rail's arrow navigation) can't
  // consume the press first; `stopPropagation` keeps it from reaching them afterwards either.
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const candidate = bindingFromEvent(event);
      // A bare modifier is the user still assembling the chord — keep listening.
      if (candidate === null) return;
      event.preventDefault();
      event.stopPropagation();
      // Escape backs out without binding, so the recorder is never a trap.
      if (candidate === 'Escape') onCancel();
      else onCapture(candidate);
      // Focus returns to the trigger so the keyboard flow continues from where it left off.
      buttonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [recording, onCancel, onCapture]);

  const shown = displayBinding(binding, IS_MAC);
  const label = t(action.messageKey);

  return (
    <SettingRow
      label={label}
      description={
        conflicting
          ? t('hotkeys.row.conflict')
          : binding === ''
            ? t('hotkeys.row.unbound')
            : t('hotkeys.row.bound', { vars: { binding: shown } })
      }
      noWrap
    >
      <div className="flex items-center gap-2">
        {conflicting ? (
          <WarningIcon className="size-4 text-warning" aria-hidden data-testid="hotkey-conflict" />
        ) : null}
        <Button
          ref={buttonRef}
          variant={recording ? 'primary' : 'outline'}
          disabled={disabled}
          onClick={recording ? onCancel : onRecord}
          data-testid={`hotkey-record-${action.id}`}
          aria-label={
            recording
              ? t('hotkeys.row.recordingAria', { vars: { action: label } })
              : binding === ''
                ? t('hotkeys.row.bindAria', { vars: { action: label } })
                : t('hotkeys.row.rebindAria', { vars: { action: label, binding: shown } })
          }
          className="min-w-28 font-mono text-xs"
        >
          {recording ? t('hotkeys.row.recording') : shown === '' ? t('hotkeys.row.none') : shown}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={disabled || binding === ''}
          onClick={onClear}
          data-testid={`hotkey-clear-${action.id}`}
          aria-label={t('hotkeys.row.clearAria', { vars: { action: label } })}
        >
          <CloseIcon />
        </Button>
      </div>
    </SettingRow>
  );
}
