import type { ReactNode } from 'react';

/**
 * An inline external link for the guide — opens in a new tab with safe `rel`, styled to match
 * the app's other inline links. Children may include a trailing icon (e.g. an external-link
 * glyph); the anchor sizes any nested SVG to match the text.
 */
export function GuideLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:text-primary/80 [&_svg]:size-3.5"
    >
      {children}
    </a>
  );
}
