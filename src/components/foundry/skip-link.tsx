import { type MouseEvent } from 'react';

/**
 * The id of the per-screen primary-content landmark the {@link SkipLink} targets.
 * Every routed screen places this on its `<main>` so a single global skip link
 * works on every route (spec §3 — WCAG 2.4.1 Bypass Blocks).
 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Foundry SkipLink — the accessible "skip to content" bypass (spec §2.4.1 / §3).
 *
 * Rendered once as the very first focusable element in the app shell, it is
 * visually hidden until it receives keyboard focus, then jumps focus past the
 * per-screen navigation header to the `#${MAIN_CONTENT_ID}` landmark. The landmark
 * carries `tabIndex={-1}` so it accepts programmatic focus without joining the tab
 * order. We move focus explicitly rather than relying on the `href` fragment alone,
 * because a hash navigation scrolls but does not reliably move focus for a screen
 * reader / keyboard user.
 */
export function SkipLink() {
  const onActivate = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(MAIN_CONTENT_ID);
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView?.();
  };

  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={onActivate}
      className="sr-only rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
    >
      Skip to content
    </a>
  );
}
