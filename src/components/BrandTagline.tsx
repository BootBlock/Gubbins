import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { cn } from '@/lib/utils';

/**
 * The user's **brand tagline** (Branding, issue #110) — a short custom label (an organisation or
 * family name, a site, a slogan) shown in a muted tone beside the fixed "Gubbins" wordmark in the app
 * chrome, so a user can brand their own copy. The "Gubbins" name itself is never editable; this is an
 * addition that sits alongside it (e.g. "Gubbins · Acme Widgets").
 *
 * Reads the tagline from {@link usePreferencesStore} and renders nothing when it is blank (the
 * shipped look is unchanged until set). The leading separator is decorative (`aria-hidden`); the
 * tagline text itself is read normally, so assistive tech announces "Gubbins, Acme Widgets".
 */
export function BrandTagline({ className }: { readonly className?: string }) {
  const tagline = usePreferencesStore((s) => s.brandTagline).trim();
  if (!tagline) return null;
  return (
    <span
      data-testid="brand-tagline"
      className={cn('inline-flex items-center gap-1.5 font-normal text-muted-foreground', className)}
    >
      <span aria-hidden="true">·</span>
      <span>{tagline}</span>
    </span>
  );
}
