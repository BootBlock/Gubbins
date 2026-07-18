/**
 * The Settings dialog's **Hotkeys** tab (issues #32, #127) — the master switch, a preset picker,
 * and one rebindable row per action.
 *
 * Rebinding is *recorded*, not typed: pressing "Change" puts the row into a capture state where
 * the very next chord becomes the binding. That is the only honest way to bind a key — asking
 * someone to type `Ctrl+Shift+I` into a text box means parsing prose, and gets the modifier
 * spelling wrong on every platform but the author's. Capture runs on `keydown` in the **capture
 * phase** so the chord can't be swallowed by the dialog's own handlers on its way past (the
 * `use-search-escape.ts` precedent), and Escape cancels rather than binding, since a key you
 * cannot get out of the recorder with is a trap.
 *
 * **Recording a two-key sequence** (issue #127) keeps that press-once feel rather than adding a
 * mode to choose first: the captured chord commits *immediately*, exactly as before, and the row
 * then stays briefly receptive — press a second key within {@link SEQUENCE_TIMEOUT_MS} and the
 * binding is upgraded in place to `G R`. So binding a single key costs one press (no waiting for a
 * timeout to prove you had finished), and binding a sequence costs two, which is what it is.
 *
 * **Conflicts are resolved in place** rather than only flagged: a row sharing its key names the
 * rival and offers to unbind it, because "two things use this key, go and find the other one"
 * leaves the user to do the search themselves.
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
import { SEQUENCE_TIMEOUT_MS } from './useGlobalHotkeys';
import {
  HOTKEY_ACTIONS,
  HOTKEY_PRESETS,
  SEQUENCE_SEPARATOR,
  applyHotkeyPreset,
  bindingFromEvent,
  displayBinding,
  findHotkeyConflictRivals,
  hotkeyAction,
  isMacKeyboard,
  normaliseHotkeyBindings,
  rejectBinding,
  type HotkeyAction,
  type HotkeyActionId,
  type HotkeyPresetId,
} from './hotkeys';

/** On/off pair, mirroring the Settings dialog's own boolean control convention. */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** Spell modifiers the macOS way (`⌘⇧K`) rather than `Ctrl+Shift+K`; settled once at load. */
const IS_MAC = isMacKeyboard();

/**
 * Keys that end the "extend into a sequence" window instead of becoming its second chord.
 *
 * These are how a keyboard user *moves on* from a row they have just bound — Tab to the next
 * control, Escape to close, Enter/Space to activate what they land on, arrows to walk the Settings
 * rail. Treating any of them as a second chord would make the row a trap for exactly the users who
 * rely on it most. Escape additionally means "I'm done": the single chord already committed stands,
 * because the user asked for it and got it — they have only declined to extend it.
 */
const EXTEND_EXEMPT_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'Shift+Tab',
  'Escape',
  'Enter',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export function HotkeySettings() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const setEnabled = usePreferencesStore((s) => s.setHotkeysEnabled);
  const stored = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const setBinding = usePreferencesStore((s) => s.setHotkeyBinding);
  const setBindings = usePreferencesStore((s) => s.setHotkeyBindings);
  const resetBindings = usePreferencesStore((s) => s.resetHotkeyBindings);
  const enabledFeatures = useEnabledFeatures();

  // Which row is currently listening for a chord, or null while idle.
  const [recording, setRecording] = useState<HotkeyActionId | null>(null);
  // The outcome of the last capture — announced, and shown beneath the row that caused it.
  const [notice, setNotice] = useState<string | null>(null);
  // The scheme selected in the picker but not yet applied. Applying is a separate, deliberate
  // press because it overwrites every row — not something a stray change event should do.
  const [preset, setPreset] = useState<HotkeyPresetId | ''>('');

  // Derived once per change rather than per render — this also keeps `bindings` stable, so a
  // row's capture listener isn't torn down and re-added on every keystroke in the recorder.
  const bindings = useMemo(() => normaliseHotkeyBindings(stored), [stored]);
  const rivals = useMemo(() => findHotkeyConflictRivals(bindings), [bindings]);
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

        <SettingRow label={t('hotkeys.preset.label')} description={t('hotkeys.preset.description')} noWrap>
          <div className="flex items-center gap-2">
            <Select
              className="h-9 w-44"
              aria-label={t('hotkeys.preset.label')}
              data-testid="setting-hotkeys-preset"
              disabled={!enabled}
              value={preset}
              onChange={(v) => setPreset(v as HotkeyPresetId | '')}
              options={[
                { value: '', label: t('hotkeys.preset.placeholder') },
                ...HOTKEY_PRESETS.map((p) => ({ value: p.id, label: t(p.messageKey) })),
              ]}
            />
            <Button
              variant="outline"
              disabled={!enabled || preset === ''}
              data-testid="setting-hotkeys-preset-apply"
              onClick={() => {
                if (preset === '') return;
                const chosen = HOTKEY_PRESETS.find((p) => p.id === preset);
                setBindings(applyHotkeyPreset(preset));
                setRecording(null);
                setNotice(
                  t('hotkeys.preset.applied', {
                    vars: { preset: chosen ? t(chosen.messageKey) : preset },
                  }),
                );
              }}
            >
              {t('hotkeys.preset.action')}
            </Button>
          </div>
        </SettingRow>

        {visible.map((action) => (
          <HotkeyRow
            key={action.id}
            action={action}
            binding={bindings[action.id]}
            rivals={rivals.get(action.id) ?? []}
            disabled={!enabled}
            recording={recording === action.id}
            onUnbindRival={(rival) => {
              setBinding(rival, '');
              setNotice(
                t('hotkeys.cleared', {
                  vars: { action: t(hotkeyAction(rival)?.messageKey ?? action.messageKey) },
                }),
              );
            }}
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
  rivals,
  disabled,
  recording,
  onRecord,
  onCancel,
  onCapture,
  onUnbindRival,
  onClear,
}: {
  readonly action: HotkeyAction;
  readonly binding: string;
  /** Other actions holding this row's key — empty when there is no conflict. */
  readonly rivals: readonly HotkeyActionId[];
  readonly disabled: boolean;
  readonly recording: boolean;
  readonly onRecord: () => void;
  readonly onCancel: () => void;
  readonly onCapture: (binding: string) => void;
  readonly onUnbindRival: (rival: HotkeyActionId) => void;
  readonly onClear: () => void;
}) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The chord just committed, while the row is still receptive to a second one (see the module
  // docstring). Null whenever a sequence can no longer be extended.
  const [extendable, setExtendable] = useState<string | null>(null);
  const conflicting = rivals.length > 0;

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
      if (candidate === 'Escape') {
        onCancel();
      } else {
        onCapture(candidate);
        // Stay receptive: a second chord now upgrades this to a sequence.
        setExtendable(candidate);
      }
      // Focus returns to the trigger so the keyboard flow continues from where it left off.
      buttonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [recording, onCancel, onCapture]);

  // The extend window. Deliberately the *same* budget the live matcher gives a sequence prefix,
  // so the rhythm that records `G R` is the rhythm that later triggers it.
  useEffect(() => {
    if (extendable === null) return;
    const timer = setTimeout(() => setExtendable(null), SEQUENCE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [extendable]);

  // Second chord → upgrade the binding in place. A separate listener from the recorder above
  // because this one runs *after* the row has stopped recording.
  useEffect(() => {
    if (extendable === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const next = bindingFromEvent(event);
      if (next === null) return;
      // The keys that move you *around* the dialog are never a second chord — they are how a
      // keyboard user leaves this row. Swallowing Tab here would make the row a trap: you could
      // not step to the next control without silently turning your new binding into a sequence.
      if (EXTEND_EXEMPT_KEYS.has(next)) {
        setExtendable(null);
        return; // deliberately unclaimed — let the press do its normal job
      }
      event.preventDefault();
      event.stopPropagation();
      setExtendable(null);
      onCapture(`${extendable}${SEQUENCE_SEPARATOR}${next}`);
      buttonRef.current?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [extendable, onCapture]);

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
          <>
            <WarningIcon className="size-4 text-warning" aria-hidden data-testid="hotkey-conflict" />
            {/* Resolve it here rather than sending the user hunting for the other row. Only the
              first rival is offered: with three-way conflicts (rare, and always transient) each
              press resolves one, and the control simply re-points at whoever is left. */}
            {rivals[0] !== undefined ? (
              <Button
                variant="ghost"
                className="h-8 px-2 text-xs"
                disabled={disabled}
                onClick={() => onUnbindRival(rivals[0] as HotkeyActionId)}
                data-testid={`hotkey-unbind-rival-${action.id}`}
                aria-label={t('hotkeys.row.unbindRivalAria', {
                  vars: {
                    action: t(hotkeyAction(rivals[0] as HotkeyActionId)?.messageKey ?? action.messageKey),
                  },
                })}
              >
                {t('hotkeys.row.unbindRival', {
                  vars: {
                    action: t(hotkeyAction(rivals[0] as HotkeyActionId)?.messageKey ?? action.messageKey),
                  },
                })}
              </Button>
            ) : null}
          </>
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
        {/* Only while the row is receptive, so the sequence affordance is discoverable at the one
          moment it applies rather than adding permanent clutter to every row. */}
        {extendable !== null ? (
          <span className="text-xs text-muted-foreground" data-testid={`hotkey-extend-${action.id}`}>
            {t('hotkeys.row.recordingSequence')}
          </span>
        ) : null}
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
