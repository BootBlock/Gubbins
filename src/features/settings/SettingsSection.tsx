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
import { cn } from '@/lib/utils';

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
  stack,
  noWrap,
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
  /**
   * Force the control onto its own line *below* the label/description instead of trailing
   * to the right. The row already wraps the control below when a long description crowds it
   * out; `stack` makes that layout deterministic so a set of related rows reads consistently
   * regardless of how long each description happens to be.
   */
  readonly stack?: boolean;
  /**
   * The opposite pull to {@link stack}: keep the control trailing to the right even when the
   * description is long enough that the default wrap would otherwise drop it onto its own line
   * below. The label/description column shrinks and wraps its own text instead, so a set of
   * related action rows keeps their buttons aligned in a single right-hand column (e.g. the
   * App tab's Manage modules / About buttons). Ignored when `stack` is set — they conflict, and
   * `stack` (which relies on the wrap to place the control below) wins.
   */
  readonly noWrap?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0',
        noWrap && !stack ? 'flex-nowrap' : 'flex-wrap',
      )}
    >
      <div className={cn('min-w-0', stack && 'basis-full')}>
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
