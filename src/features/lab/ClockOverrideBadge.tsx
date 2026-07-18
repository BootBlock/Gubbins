/**
 * ClockOverrideBadge — a persistent marker shown while the hidden lab screen's date override is
 * active.
 *
 * The override is the one lab switch whose effect is invisible *and* far-reaching: it changes what
 * counts as expired, overdue, due for service and dead stock across every screen, but the app
 * otherwise looks entirely normal. Left set and forgotten, it turns into hours of confusion —
 * "why does this say the warranty ran out?" — so a shifted clock always says so on screen.
 *
 * Rendered from the composition root rather than from `PageHeader`, deliberately: the header is a
 * Foundry primitive, and having the primitive layer reach into feature state would invert the
 * layering. A fixed, pointer-inert badge needs no cooperation from any screen and appears on all of
 * them, including screens that predate this feature.
 */
import { useLabStore } from '@/state/stores/useLabStore';
import { useT } from '@/features/i18n';

export function ClockOverrideBadge() {
  const dateOverride = useLabStore((state) => state.dateOverride);
  const t = useT();
  if (!dateOverride) return null;
  return (
    <div
      // `status` + polite: a screen-reader user is told the app is on a shifted clock once, without
      // interrupting whatever they are doing.
      role="status"
      aria-live="polite"
      data-testid="clock-override-badge"
      className="print-hide pointer-events-none fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-warning px-3 py-1 text-xs font-medium text-warning-foreground shadow-lg"
    >
      {t('lab.date.badge')} — {dateOverride}
    </div>
  );
}
