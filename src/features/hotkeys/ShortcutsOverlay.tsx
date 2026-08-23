/**
 * The keyboard-shortcuts cheat sheet (issue #127) — a `?` overlay listing every shortcut that
 * can actually fire right now.
 *
 * Before this existed, the only way to learn what was bound was to open Settings and read the
 * rebinding list — which is the place you go to *change* a shortcut, not to discover one. A cheat
 * sheet on `?` is the conventional companion to a hotkey system, and it is what makes the rest of
 * the feature findable at all.
 *
 * **It shows what is live, not what is possible.** Unbound actions are omitted, and so is any
 * action whose module is switched off or whose contextual handler no screen has registered — the
 * list is a description of this moment, on this screen, or it is misinformation. That is also why
 * "On this screen" is a separate group: those rows genuinely change as you navigate.
 */
import { useMemo } from 'react';
import { Button, Kbd, Modal } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermissionCheck } from '@/features/users/usePermission';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useHotkeyScopeStore } from './useHotkeyScope';
import {
  HOTKEY_ACTIONS,
  displayBinding,
  isMacKeyboard,
  normaliseHotkeyBindings,
  type HotkeyAction,
  hotkeyPermission,
} from './hotkeys';

/** Spell modifiers the macOS way (`⌘⇧K`) rather than `Ctrl+Shift+K`; settled once at load. */
const IS_MAC = isMacKeyboard();

/** The three sections, in the order the sheet lists them. */
type Group = 'navigate' | 'actions' | 'contextual';

function groupOf(action: HotkeyAction): Group {
  if (action.scoped === true) return 'contextual';
  return action.effect.kind === 'navigate' ? 'navigate' : 'actions';
}

const GROUP_ORDER: readonly Group[] = ['navigate', 'actions', 'contextual'];

const GROUP_HEADING = {
  navigate: 'hotkeys.overlay.group.navigate',
  actions: 'hotkeys.overlay.group.actions',
  contextual: 'hotkeys.overlay.group.contextual',
} as const;

export default function ShortcutsOverlayBody({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.hotkeysEnabled);
  const stored = usePreferencesStore((s) => s.hotkeyBindings);
  const paletteEnabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  const enabledFeatures = useEnabledFeatures();
  const allows = usePermissionCheck();
  const openSettings = useSettingsDialog((s) => s.openSettings);
  // Subscribed, not read imperatively: the contextual rows must re-render when the user navigates
  // to a screen that offers a different "new".
  const scopeEntries = useHotkeyScopeStore((s) => s.entries);

  // Memoised like every other consumer of this seam: the overlay subscribes to the scope registry,
  // which changes on each screen mount/unmount, so an unmemoised call would re-walk and re-validate
  // the whole registry on every navigation.
  const bindings = useMemo(() => normaliseHotkeyBindings(stored), [stored]);

  const rows = useMemo(() => {
    const hasScopedHandler = (command: 'screen-new' | 'screen-search') => {
      const key = command === 'screen-new' ? 'onNew' : 'onSearch';
      return scopeEntries.some((entry) => entry[key] !== undefined);
    };
    return HOTKEY_ACTIONS.filter((action) => {
      if (bindings[action.id] === '') return false;
      if (action.feature !== undefined && !enabledFeatures.has(action.feature)) return false;
      if (!allows(hotkeyPermission(action))) return false;
      if (action.requiresPref === 'dashboardCommandPalette' && !paletteEnabled) return false;
      // A contextual row with nobody to handle it would be a shortcut that does nothing.
      if (action.effect.kind === 'command' && action.scoped === true) {
        if (action.effect.command !== 'screen-new' && action.effect.command !== 'screen-search') {
          return false;
        }
        return hasScopedHandler(action.effect.command);
      }
      return true;
    });
  }, [bindings, enabledFeatures, allows, paletteEnabled, scopeEntries]);

  return (
    <Modal
      open
      onClose={onClose}
      title={t('hotkeys.overlay.title')}
      description={t('hotkeys.overlay.intro')}
      className="max-w-lg"
    >
      {!enabled ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('hotkeys.overlay.disabled')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hotkeys.overlay.empty')}</p>
      ) : (
        <div className="space-y-5">
          {GROUP_ORDER.map((group) => {
            const inGroup = rows.filter((action) => groupOf(action) === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} aria-labelledby={`shortcuts-group-${group}`}>
                <h3
                  id={`shortcuts-group-${group}`}
                  className="mb-field-gap-compact text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {t(GROUP_HEADING[group])}
                </h3>
                <ul className="space-y-1">
                  {inGroup.map((action) => (
                    <li
                      key={action.id}
                      className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 odd:bg-card/60"
                      data-testid={`shortcut-row-${action.id}`}
                    >
                      <span className="min-w-0 truncate text-sm text-foreground">{t(action.messageKey)}</span>
                      <Kbd>{displayBinding(bindings[action.id], IS_MAC)}</Kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-5 flex justify-end border-t border-border pt-3">
        <Button
          variant="outline"
          data-testid="shortcuts-overlay-edit"
          onClick={() => {
            // Close first: the Settings dialog is a modal too, and stacking the cheat sheet
            // behind it would leave Escape dismissing the wrong one.
            onClose();
            openSettings('hotkeys');
          }}
        >
          {t('hotkeys.overlay.edit')}
        </Button>
      </div>
    </Modal>
  );
}
