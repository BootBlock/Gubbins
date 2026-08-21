/**
 * ClockSkewBadge — a persistent marker shown while this device's clock is materially wrong
 * (issue #326).
 *
 * The sibling of `features/lab/ClockOverrideBadge`, and it exists for the same reason: a wrong
 * clock changes what counts as expired, overdue, due for service and dead stock across every
 * screen, while the app otherwise looks entirely normal. Gubbins now *corrects* for the error
 * rather than judging on it, but a silent correction is its own kind of confusion — a user
 * comparing Gubbins against the clock in their taskbar needs to know which one the app believes.
 * So a material skew always says so on screen, and says which way it runs.
 *
 * Rendered from the composition root rather than from `PageHeader`, for the same layering reason
 * the override badge is: a fixed, pointer-inert badge needs no cooperation from any screen and
 * appears on all of them.
 */
import { useClockSkewStore } from '@/state/stores/useClockSkewStore';
import { useLabStore } from '@/state/stores/useLabStore';
import { cn } from '@/lib/utils';
import { useT } from '@/features/i18n';
import { describeSkewDuration, isMaterialSkew, skewDirection } from './skew';

export function ClockSkewBadge() {
  const skewMs = useClockSkewStore((state) => state.skewMs);
  // The lab's date override deliberately falsifies the clock and already shows its own badge in
  // this slot; stacking above it keeps both readable when a maintainer is testing on a device
  // that also happens to have a wrong clock.
  const dateOverride = useLabStore((state) => state.dateOverride);
  const t = useT();

  if (!isMaterialSkew(skewMs)) return null;

  // Direction and magnitude are rendered from separate keys rather than spliced out of a
  // relative-time phrase: "3 hours ago" is a point in time, not a length of one, so folding it
  // into a sentence produced copy that read as a promise about the future. The duration keys
  // carry their own plural forms, so each catalog controls its own agreement.
  const { unit, count } = describeSkewDuration(skewMs);
  const amount = t(`clock.skew.duration.${unit}`, { vars: { count } });
  const key = skewDirection(skewMs) === 'fast' ? 'clock.skew.badge.ahead' : 'clock.skew.badge.behind';

  return (
    <div
      // `status` + polite: a screen-reader user is told the device clock is wrong once, without
      // interrupting whatever they are doing.
      role="status"
      aria-live="polite"
      data-testid="clock-skew-badge"
      className={cn(
        'print-hide pointer-events-none fixed left-1/2 z-50 mb-safe-bottom -translate-x-1/2 rounded-full bg-warning px-3 py-1 text-xs font-medium text-warning-foreground shadow-lg',
        dateOverride ? 'bottom-11' : 'bottom-3',
      )}
    >
      {t(key, { vars: { amount } })}
    </div>
  );
}
