import { cn } from '@/lib/utils';

/**
 * A subtle "value changed" delight: wrap a displayed number so that whenever its
 * value changes the existing one-shot `animate-pulse-success` glow replays on it.
 *
 * The replay is driven purely by a React `key` that tracks `flashKey`: when the key
 * changes React remounts the inner span, restarting the one-shot CSS animation. The
 * rendered text is always `children` (the true current value), so screen readers and
 * automated tests still read the real number — only the decorative glow animates.
 *
 * `animate-pulse-success` is auto-neutralised by the global
 * `@media (prefers-reduced-motion: reduce)` catch-all, so no extra JS gating is needed.
 */
export function ChangeFlash({
  flashKey,
  className,
  children,
}: {
  /** Value-derived key; a change replays the glow. Usually the number itself. */
  flashKey: string | number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span key={flashKey} className={cn('inline-block rounded animate-pulse-success', className)}>
      {children}
    </span>
  );
}
