/**
 * The per-group settings picker (issue #175), shared by every screen that asks "which settings?".
 *
 * Three places ask it, and they must ask it the same way: creating a backup chooses which groups
 * travel into the file, restoring one chooses which of the groups it carries land here, and live
 * settings sync (issue #382) chooses which travel between devices continuously. The grouping is the
 * same partition in all three, so re-styling a second checkbox list per screen would only create
 * somewhere for them to drift apart.
 *
 * `ids` is the set of groups on offer — every group when creating a backup, only the ones the file
 * actually contains when restoring, only the live-syncable ones for settings sync.
 */
import type { MessageKey } from '@/features/i18n';
import { useT } from '@/features/i18n';
import { Button } from '@/components/foundry';
import { settingsGroup, type SettingsGroupId, type SettingsGroupSelection } from './settings-groups';

export function SettingsGroupPicker({
  ids,
  value,
  onChange,
  titleKey,
  hintKey,
  emptyKey,
  testIdPrefix,
  disabled = false,
}: {
  ids: readonly SettingsGroupId[];
  value: SettingsGroupSelection;
  onChange: (next: SettingsGroupSelection) => void;
  titleKey: MessageKey;
  hintKey: MessageKey;
  /** Note shown when the user has unticked everything on offer. */
  emptyKey: MessageKey;
  testIdPrefix: string;
  /** Greys the whole fieldset out — for a picker whose feature is currently switched off. */
  disabled?: boolean;
}) {
  const t = useT();
  // Only the groups on offer change; anything not offered keeps its current value.
  const setAll = (on: boolean) => onChange({ ...value, ...Object.fromEntries(ids.map((id) => [id, on])) });
  const noneChosen = ids.every((id) => !value[id]);

  return (
    <fieldset
      className="space-y-field-gap-compact rounded-lg border border-border/60 bg-secondary/20 p-3 disabled:opacity-60"
      disabled={disabled}
    >
      <legend className="sr-only">{t(titleKey)}</legend>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-foreground">{t(titleKey)}</p>
          <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)} data-testid={`${testIdPrefix}-all`}>
            {t('backup.settings.selectAll')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAll(false)}
            data-testid={`${testIdPrefix}-none`}
          >
            {t('backup.settings.selectNone')}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {ids.map((id) => {
          const group = settingsGroup(id);
          if (!group) return null;
          return (
            // eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested checkbox is correctly associated; the label's text comes from the translated group name, which the linter cannot resolve to a static string.
            <label
              key={id}
              className="flex cursor-pointer items-start gap-3 rounded-md p-1.5 hover:bg-secondary/40"
            >
              <input
                type="checkbox"
                checked={value[id]}
                onChange={() => onChange({ ...value, [id]: !value[id] })}
                className="mt-0.5 size-4 accent-primary"
                data-testid={`${testIdPrefix}-${id}`}
              />
              <span className="flex-1">
                <span className="block text-xs font-medium">{t(group.labelKey)}</span>
                <span className="block text-xs text-muted-foreground">{t(group.hintKey)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {noneChosen ? (
        <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
          {t(emptyKey)}
        </p>
      ) : null}
    </fieldset>
  );
}
