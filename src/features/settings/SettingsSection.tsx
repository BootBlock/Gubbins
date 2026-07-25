/**
 * Shared Settings layout primitives.
 *
 * `SettingsSection` (a titled `Surface` card) and `SettingRow` (a label/description +
 * trailing control) are the building blocks the Settings dialog composes. They live in
 * their own module — rather than inside `SettingsDialog` — so sibling sections such as
 * the Danger Zone and Database maintenance can reuse them without importing back from the
 * dialog (which would create an import cycle).
 *
 * Both are also where the dialog's cross-tab filter (issue #133) is enforced: a row matches
 * the query itself and drops out when it doesn't, and a section with nothing left hides. That
 * lives here rather than in the dialog because these primitives are the one thing every
 * setting has in common, wherever its JSX is written — see {@link ./settings-search}.
 */
import { type ReactNode } from 'react';
import { InfoHint, Surface, type TooltipSize } from '@/components/foundry';
import { cn } from '@/lib/utils';
import { useSettingSearchMatch, useSettingsSearchContainer } from './settings-search';

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
  const search = useSettingsSearchContainer(title);
  return (
    // Hidden rather than unmounted: the children are what report whether anything inside still
    // matches, so they have to stay in the tree for the section to ever come back. `inert` is
    // what keeps that honest — a section can hold a focusable that isn't a `SettingRow` (the
    // Card-fields picker, the reduced-motion notice's link), and a `display: none` control the
    // dialog's focus trap still finds would make Tab a dead key. See `foundry/focus-trap`.
    <Surface id={id} inert={search.hidden} className={cn('p-5', search.hidden && 'hidden')}>
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="mt-4 divide-y divide-border">{search.wrap(children)}</div>
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
  fill,
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
  /**
   * Let the control span the **full row width** (rather than sizing to its content on the
   * right). Needed for a control that must lay out across the row and wrap its own children —
   * e.g. the Appearance theme picker, a `flex-wrap` group of pills that would otherwise
   * overflow. Pair with {@link stack} so the full-width control sits on its own line below the
   * label. Without it the control is `shrink-0` (content-width, trailing right) as before.
   */
  readonly fill?: boolean;
  readonly children: ReactNode;
}) {
  // The dialog's filter, applied at the one place every setting passes through. Matching on the
  // hint as well as the visible copy is deliberate: the hints carry the vocabulary people
  // actually search for ("OLED", "wake lock", "reorder point") that the one-line description
  // has no room for. `first:pt-0 last:pb-0` keys off the *rendered* rows, so a filtered section
  // keeps its dividers tidy.
  const matchesSearch = useSettingSearchMatch([label, description, hint]);
  if (!matchesSearch) return null;

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
      {/* `basis-full` gives the control a definite full-row width so a `flex-wrap` child
          can wrap; otherwise `shrink-0` keeps it content-sized and trailing right. */}
      <div className={cn(fill ? 'min-w-0 basis-full' : 'shrink-0')}>{children}</div>
    </div>
  );
}
