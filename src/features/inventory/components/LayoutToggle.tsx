import { cn } from '@/lib/utils';
import { DataDensityIcon, VisualDensityIcon } from '@/components/icons';
import { useLayoutStore, type LayoutDensity } from '@/state/stores/useLayoutStore';

/**
 * The Data-Heavy ↔ Visual-Heavy density toggle (spec §3 "Adaptive Density").
 * A sliding segmented control with a fluid animated thumb — engaging visual
 * feedback per the Phase 2 brief — backed by the persisted `useLayoutStore`.
 */
const OPTIONS: ReadonlyArray<{ value: LayoutDensity; label: string; icon: typeof DataDensityIcon }> = [
  { value: 'visual', label: 'Visual', icon: VisualDensityIcon },
  { value: 'data', label: 'Data', icon: DataDensityIcon },
];

export function LayoutToggle() {
  const density = useLayoutStore((s) => s.density);
  const setDensity = useLayoutStore((s) => s.setDensity);
  const activeIndex = OPTIONS.findIndex((o) => o.value === density);

  return (
    <div
      role="radiogroup"
      aria-label="Layout density"
      className="relative inline-flex rounded-xl border border-border bg-secondary/40 p-1"
    >
      {/* Sliding thumb */}
      <span
        aria-hidden
        className="absolute inset-y-1 w-[calc(50%-0.25rem)] rounded-lg bg-card shadow-sm shadow-black/20 ring-1 ring-border transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = option.value === density;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setDensity(option.value)}
            className={cn(
              'relative z-10 inline-flex w-24 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors [&_svg]:size-4',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
