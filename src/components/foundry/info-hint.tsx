import { InfoIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { INFO_OPEN_DELAY_MS, Tooltip, type TooltipPlacement } from './tooltip';

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
  className,
}: {
  /** Markdown help string. */
  readonly content: string;
  readonly placement?: TooltipPlacement;
  readonly className?: string;
}) {
  return (
    <Tooltip content={content} openDelayMs={INFO_OPEN_DELAY_MS} placement={placement}>
      <span
        role="img"
        aria-label="More information"
        className={cn(
          'grid size-4 cursor-help place-items-center rounded-full text-muted-foreground/70',
          'transition-colors ease-emphasized hover:text-foreground [&_svg]:size-3.5',
          className,
        )}
      >
        <InfoIcon aria-hidden />
      </span>
    </Tooltip>
  );
}
