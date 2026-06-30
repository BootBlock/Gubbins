/**
 * Shared Settings layout primitives.
 *
 * `SettingsSection` (a titled `Surface` card) and `SettingRow` (a label/description +
 * trailing control) are the building blocks the Settings screen composes. They live in
 * their own module — rather than inside `SettingsScreen` — so sibling sections such as
 * the Danger Zone can reuse them without importing back from the screen (which would
 * create an import cycle).
 */
import { type ReactNode } from 'react';
import { Surface } from '@/components/foundry';

export function SettingsSection({
  id,
  icon,
  title,
  children,
}: {
  readonly id?: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Surface id={id} className="p-5">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="mt-4 divide-y divide-border">{children}</div>
    </Surface>
  );
}

export function SettingRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
