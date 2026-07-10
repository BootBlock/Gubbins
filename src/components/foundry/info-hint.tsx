import { InfoIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { INFO_OPEN_DELAY_MS, Tooltip, type TooltipPlacement, type TooltipSize } from './tooltip';

/**
 * Foundry InfoHint — a small `i` information badge that surfaces a **rich-Markdown**
 * {@link Tooltip} of supplementary help next to a control or label (spec §2.4.1,
 * §3). It is the deliberate, app-wide replacement for the browser's plain `title`
 * attribute on form fields.
 *
 * Because the glyph exists *solely* to offer help, it opens on the snappier
 * {@link INFO_OPEN_DELAY_MS} dwell rather than the slower control default, and it is
 * keyboard-focusable so the help is reachable without a pointer. Its accessible name
 * is the deliberately generic "More information" (the Markdown body carries the
 * specifics via the tooltip's `aria-describedby`); keeping it field-agnostic also
 * means it never collides with a `getByLabel('<field>')` query in tests.
 */
export function InfoHint({
  content,
  placement = 'top',
  size,
  className,
}: {
  /** Markdown help string. */
  readonly content: string;
  readonly placement?: TooltipPlacement;
  /** Widen the bubble for richer help (tables, code, longer docs). Defaults to `sm`. */
  readonly size?: TooltipSize;
  readonly className?: string;
}) {
  return (
    <Tooltip content={content} openDelayMs={INFO_OPEN_DELAY_MS} placement={placement} size={size}>
      <span
        role="img"
        aria-label="More information"
        className={cn(
          'relative grid size-4 cursor-help place-items-center rounded-full text-muted-foreground/70',
          'transition-colors ease-emphasized hover:text-foreground [&_svg]:size-3.5',
          // Enlarge the *touch* target without growing the visible glyph: a transparent
          // pseudo-element extends the tappable area to a comfortable ~36px (a small badge
          // is hard to tap on touch) while the badge itself stays 16px. It is absolutely
          // positioned so it never affects layout, and it lives inside the Tooltip trigger,
          // so a tap on it still bubbles to the trigger's handlers.
          "before:absolute before:-inset-2.5 before:content-['']",
          className,
        )}
      >
        <InfoIcon aria-hidden />
      </span>
    </Tooltip>
  );
}
