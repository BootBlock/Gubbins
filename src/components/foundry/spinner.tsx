import { cn } from '@/lib/utils';

export interface SpinnerProps {
  className?: string;
  /** Accessible label announced to assistive tech. */
  label?: string;
  /**
   * Render as purely decorative (`aria-hidden`, no `role`/label) — for when the spinner sits
   * beside its own visible, announced text so the wait is already conveyed. Prevents a second,
   * duplicate live region announcing alongside that label.
   */
  decorative?: boolean;
}

/**
 * Foundry Spinner — a dependency-free CSS spinner for indeterminate waits such as
 * the database boot / OPFS mount sequence (spec §2.2). Kept icon-library-agnostic.
 */
export function Spinner({ className, label = 'Loading', decorative = false }: SpinnerProps) {
  return (
    <span
      {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label })}
      className={cn(
        'inline-block size-5 animate-spin rounded-full border-2 border-current border-t-transparent text-primary',
        className,
      )}
    />
  );
}
