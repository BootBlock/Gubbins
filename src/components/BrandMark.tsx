import { cn } from '@/lib/utils';

/**
 * The Gubbins brand mark — renders the real app-icon artwork
 * (`public/icons/gubbins.svg`) so the in-app logo always matches the installed-app /
 * favicon / manifest icon and can never drift from it. The asset is referenced through
 * Vite's `BASE_URL` so it resolves under the GitHub-Pages sub-path (spec §1.2).
 *
 * Decorative: every call site pairs it with the visible "Gubbins" wordmark or an
 * `aria-label` on the surrounding control, so the image itself is `aria-hidden`.
 */
export function BrandMark({ className }: { readonly className?: string }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}icons/gubbins.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('block select-none', className)}
    />
  );
}
