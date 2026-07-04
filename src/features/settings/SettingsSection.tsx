/**
 * Shared Settings layout primitives.
 *
 * `SettingsSection` (a titled `Surface` card) and `SettingRow` (a label/description +
 * trailing control) are the building blocks the Settings dialog composes. They live in
 * their own module — rather than inside `SettingsDialog` — so sibling sections such as
 * the Danger Zone and Database maintenance can reuse them without importing back from the
 * dialog (which would create an import cycle).
 */
import { type ReactNode } from 'react';
import { InfoHint, Surface, type TooltipSize } from '@/components/foundry';

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
  hint,
  hintSize,
  children,
}: {
  readonly label: string;
  readonly description: string;
  /**
   * Optional rich-Markdown help, surfaced as a Foundry {@link InfoHint} badge beside the
   * label. Use it for the deeper "what this actually does, and when you'd want it" context
   * that would bloat the always-visible one-line `description`. The badge sits outside the
   * label text so it never collides with a `getByText(label)` query.
   */
  readonly hint?: string;
  /** Widen the hint bubble for richer help (tables, lists). Defaults to `sm`. */
  readonly hintSize?: TooltipSize;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          {hint ? <InfoHint content={hint} size={hintSize} /> : null}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
