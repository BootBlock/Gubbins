import { useRef, useState } from 'react';
import { useSlidingIndicator } from '@/components/foundry';
import type { Formatters } from '@/lib/format';
import { ANALYTICS_WINDOWS } from '../analytics-windows';

/**
 * A small segmented control selecting the trailing window (days) for the turnover + valuation
 * analytics. Tokens only; the active option uses the `primary` surface, the rest are muted.
 *
 * The `primary` surface is one pill that **slides** from the old window to the new one rather
 * than being repainted in place (issue #449) — a change of window re-scales every chart beneath
 * it, so the control says which way the window moved instead of just blinking. Where the control
 * has not been laid out (jsdom, a collapsed panel) nothing is measured and the active button
 * paints the surface itself, so the selection is always visible.
 */
export function WindowToggle({
  value,
  onChange,
  formatters,
  label = 'Analytics window',
}: {
  value: number;
  onChange: (days: number) => void;
  formatters: Formatters;
  label?: string;
}) {
  const indicator = useSlidingIndicator<HTMLButtonElement>(
    ANALYTICS_WINDOWS.findIndex((days) => days === value),
    ANALYTICS_WINDOWS.length,
  );
  // The window the pill is travelling *from*. Both ends of the journey recolour on the pill's
  // timing rather than the stock ~150ms: the option being left keeps its light label while the
  // pill is still over it, and the option being landed on does not go light before it arrives.
  //
  // Derived during render and held in state, because the frame that matters is not the one the
  // click produces — the hook measures in a layout effect and re-renders again before the paint
  // that starts the slide. A ref advanced in an effect is already back to the new value by then,
  // so the outgoing label would lose its slow transition on the very frame it needs it. The pill
  // itself says when the journey is over.
  const rendered = useRef(value);
  const [leaving, setLeaving] = useState<number | null>(null);
  if (rendered.current !== value) {
    setLeaving(rendered.current);
    rendered.current = value;
  }

  return (
    <div
      ref={indicator.containerRef}
      className="relative inline-flex items-center gap-1 rounded-lg bg-secondary/60 p-0.5"
      role="group"
      aria-label={label}
    >
      {indicator.geometry ? (
        <span
          aria-hidden="true"
          className={`gubbins-sliding-indicator absolute inset-y-0.5 left-0 rounded-md bg-primary ${
            indicator.settled ? 'is-settled' : ''
          }`}
          style={{
            width: `${indicator.geometry.width}px`,
            transform: `translateX(${indicator.geometry.left}px)`,
          }}
          onTransitionEnd={() => setLeaving(null)}
        />
      ) : null}
      {ANALYTICS_WINDOWS.map((days, index) => {
        const active = days === value;
        return (
          <button
            key={days}
            ref={indicator.registerOption(index)}
            type="button"
            onClick={() => onChange(days)}
            aria-pressed={active}
            className={`relative rounded-md px-2.5 py-1 text-xs font-medium tabular-nums ${
              indicator.geometry && (active || days === leaving)
                ? 'gubbins-sliding-indicator-label'
                : 'transition-colors'
            } ${active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'} ${
              active && !indicator.geometry ? 'bg-primary' : ''
            }`}
          >
            {formatters.quantity(days)}d
          </button>
        );
      })}
    </div>
  );
}
